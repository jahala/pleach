/**
 * Integration tests for src/seams/isolate.ts
 *
 * Uses REAL git repos built in mkdtemp dirs. No mocks.
 * Each test gets its own repo to eliminate cross-test worktree interference.
 * Local ExecFn helper (Bun.spawn arg-arrays) is defined here per agent protocol:
 * the exec seam PR has not merged yet.
 */
import { expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IsolateCatastrophicError } from '../../src/core/errors.ts';
import type { ExecFn } from '../../src/loop/deps.ts';
import { createIsolateSeam } from '../../src/seams/isolate.ts';

// ── Local ExecFn (Bun.spawn arg-arrays) ────────────────────────────────────
const execLocal: ExecFn = async (argv, { cwd, timeoutMs, env }) => {
  const proc = Bun.spawn(argv as string[], {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let killed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      killed = true;
      proc.kill();
    }, timeoutMs);
  }

  const [stdoutBuf, stderrBuf] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (timer !== undefined) clearTimeout(timer);
  return {
    output: stdoutBuf + stderrBuf,
    stdout: stdoutBuf,
    exitCode: killed ? 1 : exitCode,
  };
};

// ── Git repo helpers ────────────────────────────────────────────────────────

interface Repo {
  path: string;
  cleanup: () => Promise<void>;
}

async function gitIn(repoPath: string, ...args: string[]): Promise<string> {
  const r = await execLocal(['git', '-C', repoPath, ...args], { cwd: repoPath });
  if (r.exitCode !== 0) {
    throw new Error(`git -C ${repoPath} ${args.join(' ')} exited ${r.exitCode}:\n${r.output}`);
  }
  return r.output.trim();
}

async function createRepo(): Promise<Repo> {
  const path = await mkdtemp(join(tmpdir(), 'pleach-test-'));
  await execLocal(['git', 'init', path], { cwd: tmpdir() });
  await gitIn(path, 'config', 'user.email', 'test@pleach.test');
  await gitIn(path, 'config', 'user.name', 'Pleach Test');

  await writeFile(join(path, 'initial.txt'), 'initial\n');
  await gitIn(path, 'add', 'initial.txt');
  await gitIn(path, 'commit', '-m', 'initial');

  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}

/** Create a branch off HEAD, write files, commit, return to master/main. */
async function makeBranch(
  repoPath: string,
  branch: string,
  files: Record<string, string>,
): Promise<void> {
  await gitIn(repoPath, 'checkout', '-b', branch);
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(repoPath, name);
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    if (dir !== repoPath) await mkdir(dir, { recursive: true });
    await writeFile(filePath, content);
  }
  await gitIn(repoPath, 'add', '-A');
  await gitIn(repoPath, 'commit', '-m', `branch ${branch}`);
  // Return to default branch (master or main)
  const branches = await execLocal(['git', '-C', repoPath, 'branch'], { cwd: repoPath });
  const defaultBranch = branches.output.includes('master') ? 'master' : 'main';
  await gitIn(repoPath, 'checkout', defaultBranch);
}

// ── Tests — each creates its own repo ───────────────────────────────────────

// spec §6 — fan-out: two detached worktrees off one ref concurrently
test('spec: fan-out — two concurrent isolates off one ref succeed without conflict', async () => {
  // ledger: fan-out (verified-sound in ledger §1 "Verified-sound" section)
  const repo = await createRepo();
  try {
    await makeBranch(repo.path, 'node/A-fanout', { 'fanout.txt': 'fanout content\n' });
    const seam = createIsolateSeam(execLocal, repo.path);

    const nodeA = { id: 'A-fanout', needs: [], work: { prompt: 'x' } } as never;
    const nodeB = { id: 'B-fanout', needs: [], work: { prompt: 'x' } } as never;

    const [isoA, isoB] = await Promise.all([
      seam.isolate(nodeA, ['node/A-fanout']),
      seam.isolate(nodeB, ['node/A-fanout']),
    ]);

    // Both must have the file from node/A-fanout
    const { exitCode: ea } = await execLocal(['test', '-f', 'fanout.txt'], { cwd: isoA.cwd });
    const { exitCode: eb } = await execLocal(['test', '-f', 'fanout.txt'], { cwd: isoB.cwd });
    expect(ea).toBe(0);
    expect(eb).toBe(0);

    // No "already checked out" error — both succeed at different paths
    expect(isoA.cwd).not.toBe(isoB.cwd);

    await isoA.dispose();
    await isoB.dispose();
  } finally {
    await repo.cleanup();
  }
});

// ledger: B3/C1 — join with conflict: markers kept, conflictFiles populated
test('ledger: B3/C1 — join-with-conflict keeps markers, conflictFiles populated', async () => {
  const repo = await createRepo();
  try {
    // Branch A: write 'version A'
    await gitIn(repo.path, 'checkout', '-b', 'node/conflict-A');
    await writeFile(join(repo.path, 'shared.txt'), 'version A\n');
    await gitIn(repo.path, 'add', 'shared.txt');
    await gitIn(repo.path, 'commit', '-m', 'A version');

    const defaultBranch = (
      await execLocal(['git', '-C', repo.path, 'branch'], { cwd: repo.path })
    ).output.includes('master')
      ? 'master'
      : 'main';
    await gitIn(repo.path, 'checkout', defaultBranch);

    // Branch B: write 'version B' to same file (conflict guaranteed)
    await gitIn(repo.path, 'checkout', '-b', 'node/conflict-B');
    await writeFile(join(repo.path, 'shared.txt'), 'version B\n');
    await gitIn(repo.path, 'add', 'shared.txt');
    await gitIn(repo.path, 'commit', '-m', 'B version');
    await gitIn(repo.path, 'checkout', defaultBranch);

    const seam = createIsolateSeam(execLocal, repo.path);
    const node = { id: 'conflict-node', needs: [], work: { prompt: 'x' } } as never;

    const iso = await seam.isolate(node, ['node/conflict-A', 'node/conflict-B']);

    expect(iso.conflictFiles).toContain('shared.txt');
    const content = await Bun.file(join(iso.cwd, 'shared.txt')).text();
    expect(content).toContain('<<<<<<<');

    await iso.dispose();
  } finally {
    await repo.cleanup();
  }
});

// spec §6 — clean join: disjoint files, no conflict
test('spec: clean join — disjoint files, empty conflictFiles', async () => {
  const repo = await createRepo();
  try {
    await makeBranch(repo.path, 'node/clean-A', { 'fileA.txt': 'content A\n' });
    await makeBranch(repo.path, 'node/clean-B', { 'fileB.txt': 'content B\n' });

    const seam = createIsolateSeam(execLocal, repo.path);
    const node = { id: 'clean-join', needs: [], work: { prompt: 'x' } } as never;

    const iso = await seam.isolate(node, ['node/clean-A', 'node/clean-B']);

    expect(iso.conflictFiles).toEqual([]);
    const { exitCode: ea } = await execLocal(['test', '-f', 'fileA.txt'], { cwd: iso.cwd });
    const { exitCode: eb } = await execLocal(['test', '-f', 'fileB.txt'], { cwd: iso.cwd });
    expect(ea).toBe(0);
    expect(eb).toBe(0);

    await iso.dispose();
  } finally {
    await repo.cleanup();
  }
});

// ledger: B1 — missing baseRef → IsolateCatastrophicError + no leftover worktree
test('ledger: B1 — missing non-first ref → IsolateCatastrophicError, no leftover worktree', async () => {
  const repo = await createRepo();
  try {
    await makeBranch(repo.path, 'node/exist-ref', { 'exist.txt': 'exists\n' });

    const seam = createIsolateSeam(execLocal, repo.path);
    const node = { id: 'missing-ref', needs: [], work: { prompt: 'x' } } as never;

    await expect(
      seam.isolate(node, ['node/exist-ref', 'node/ghost-does-not-exist']),
    ).rejects.toThrow(IsolateCatastrophicError);

    // No leftover worktrees in THIS repo (each test has its own repo)
    const { output } = await execLocal(
      ['git', '-C', repo.path, 'worktree', 'list', '--porcelain'],
      { cwd: repo.path },
    );
    // Only the main worktree should be listed (its path = repo.path)
    const worktreeLines = output.split('\n').filter((l) => l.startsWith('worktree '));
    expect(worktreeLines).toHaveLength(1);
    expect(worktreeLines[0]).toContain(repo.path);
  } finally {
    await repo.cleanup();
  }
});

// ledger: C1 — scanMarkers: conflicted worktree returns file; after resolution returns []
test('ledger: C1 — scanMarkers returns conflicted file; clean after resolution', async () => {
  const repo = await createRepo();
  try {
    await gitIn(repo.path, 'checkout', '-b', 'node/scan-A');
    await writeFile(join(repo.path, 'scan.txt'), 'scan version A\n');
    await gitIn(repo.path, 'add', 'scan.txt');
    await gitIn(repo.path, 'commit', '-m', 'scan A');

    const defaultBranch = (
      await execLocal(['git', '-C', repo.path, 'branch'], { cwd: repo.path })
    ).output.includes('master')
      ? 'master'
      : 'main';
    await gitIn(repo.path, 'checkout', defaultBranch);

    await gitIn(repo.path, 'checkout', '-b', 'node/scan-B');
    await writeFile(join(repo.path, 'scan.txt'), 'scan version B\n');
    await gitIn(repo.path, 'add', 'scan.txt');
    await gitIn(repo.path, 'commit', '-m', 'scan B');
    await gitIn(repo.path, 'checkout', defaultBranch);

    const seam = createIsolateSeam(execLocal, repo.path);
    const node = { id: 'scan-node', needs: [], work: { prompt: 'x' } } as never;

    const iso = await seam.isolate(node, ['node/scan-A', 'node/scan-B']);

    // Markers present in the committed (worktree HEAD) file — scanMarkers finds them
    const dirty = await seam.scanMarkers(iso.cwd);
    expect(dirty).toContain('scan.txt');

    // Write resolved content (no markers) and check clean
    await writeFile(join(iso.cwd, 'scan.txt'), 'resolved content\n');
    const clean = await seam.scanMarkers(iso.cwd);
    expect(clean).toEqual([]);

    await iso.dispose();
  } finally {
    await repo.cleanup();
  }
});

// ledger: S1 — scoped stage: junk file excluded, only named files committed
test('ledger: S1 — scoped stage only commits the given files, not junk', async () => {
  const repo = await createRepo();
  try {
    await makeBranch(repo.path, 'node/stage-base', { 'real.txt': 'real content\n' });

    const seam = createIsolateSeam(execLocal, repo.path);
    const node = { id: 'stage-node', needs: [], work: { prompt: 'x' } } as never;

    const iso = await seam.isolate(node, ['node/stage-base']);

    // Write a real change and junk (like node_modules-ish.txt)
    await writeFile(join(iso.cwd, 'real.txt'), 'real updated\n');
    await writeFile(join(iso.cwd, 'node_modules-ish.txt'), 'junk\n');

    // Stage only the real file (ledger S1)
    await seam.stage(iso.cwd, ['real.txt']);
    await seam.commitBranch(iso.cwd, 'node/stage-result', 'scoped commit');

    // git show --stat must NOT contain junk file
    const { output } = await execLocal(
      ['git', '-C', iso.cwd, 'show', '--stat', '--format=', 'HEAD'],
      { cwd: iso.cwd },
    );
    expect(output).not.toContain('node_modules-ish.txt');
    expect(output).toContain('real.txt');

    await iso.dispose();
  } finally {
    await repo.cleanup();
  }
});

// Regression: workers create-and-delete probe files (toolchain smoke checks);
// a pathspec matching neither worktree nor index must not fail collection,
// while a tracked file the worker deleted still stages as a deletion.
test('stage: tolerates vanished untracked probes; still stages tracked deletions', async () => {
  const repo = await createRepo();
  try {
    await makeBranch(repo.path, 'node/ghost-base', {
      'keep.txt': 'keep\n',
      'doomed.txt': 'doomed\n',
    });

    const seam = createIsolateSeam(execLocal, repo.path);
    const node = { id: 'ghost-node', needs: [], work: { prompt: 'x' } } as never;
    const iso = await seam.isolate(node, ['node/ghost-base']);

    // The worker: adds a real file, deletes a tracked file; its probe file
    // (_realsmoke) was created and already deleted — never tracked.
    await writeFile(join(iso.cwd, 'new.txt'), 'new\n');
    await rm(join(iso.cwd, 'doomed.txt'));

    await seam.stage(iso.cwd, ['new.txt', 'doomed.txt', 'tests/_realsmoke.spec.ts']);
    await seam.commitBranch(iso.cwd, 'node/ghost-result', 'ghost-tolerant commit');

    const { output } = await execLocal(
      ['git', '-C', iso.cwd, 'show', '--stat', '--format=', 'HEAD'],
      { cwd: iso.cwd },
    );
    expect(output).toContain('new.txt');
    expect(output).toContain('doomed.txt'); // the deletion is staged
    expect(output).not.toContain('_realsmoke');

    await iso.dispose();
  } finally {
    await repo.cleanup();
  }
});

// ledger: B2 — commitBranch returns sha; refSha matches; allow-empty works
test('ledger: B2 — commitBranch returns sha; allow-empty succeeds; refSha resolves', async () => {
  const repo = await createRepo();
  try {
    await makeBranch(repo.path, 'node/commit-base', { 'committed.txt': 'committed\n' });

    const seam = createIsolateSeam(execLocal, repo.path);
    const node = { id: 'commit-node', needs: [], work: { prompt: 'x' } } as never;

    const iso = await seam.isolate(node, ['node/commit-base']);

    // Stage something and commit
    await writeFile(join(iso.cwd, 'committed.txt'), 'updated\n');
    await seam.stage(iso.cwd, ['committed.txt']);
    const { sha } = await seam.commitBranch(iso.cwd, 'node/commit-result', 'test commit');

    expect(typeof sha).toBe('string');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    // refSha from the worktree resolves to the same sha (ledger B2/B1)
    const resolved = await seam.refSha(iso.cwd, 'node/commit-result');
    expect(resolved).toBe(sha);

    // allow-empty: nothing staged — must still succeed
    const { sha: sha2 } = await seam.commitBranch(iso.cwd, 'node/empty-result', 'empty commit');
    expect(sha2).toMatch(/^[0-9a-f]{40}$/);

    await iso.dispose();
  } finally {
    await repo.cleanup();
  }
});

// ledger: D13 — commit seals a phase on the detached HEAD: it moves no branch,
// refuses an empty seal, and the close's commit stacks on it (base → red → verified)
test('ledger: D13 — commit seals on the detached HEAD; no branch moves; the close stacks', async () => {
  const repo = await createRepo();
  try {
    await makeBranch(repo.path, 'node/seal-base', { 'seed.txt': 'seed\n' });

    const seam = createIsolateSeam(execLocal, repo.path);
    const node = { id: 'seal-node', needs: [], work: { prompt: 'x' } } as never;

    const iso = await seam.isolate(node, ['node/seal-base']);
    const refsBefore = await gitIn(repo.path, 'for-each-ref', '--format=%(refname) %(objectname)');

    // The red phase: a failing test, scoped-staged and sealed.
    await writeFile(join(iso.cwd, 'red.test.txt'), 'failing test\n');
    await seam.stage(iso.cwd, ['red.test.txt']);
    const { sha } = await seam.commit(
      iso.cwd,
      'pleach: seal-node red phase\n\ntest: runtests\n\npleach-phase: red',
    );

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await gitIn(iso.cwd, 'rev-parse', 'HEAD')).toBe(sha);
    expect(await gitIn(iso.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD'); // still detached
    expect(await seam.commitMessageOf(iso.cwd, sha)).toContain('pleach-phase: red');
    // Nothing was published: every ref in the repo is exactly where it was.
    expect(await gitIn(repo.path, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(
      refsBefore,
    );

    // An empty seal is refused — no --allow-empty; there is no red state to seal.
    await expect(seam.commit(iso.cwd, 'pleach: seal-node red phase')).rejects.toBeInstanceOf(
      IsolateCatastrophicError,
    );

    // The close stacks on the seal: node/<id>'s commit has the red one as parent.
    await writeFile(join(iso.cwd, 'impl.txt'), 'impl\n');
    await seam.stage(iso.cwd, ['impl.txt']);
    const { sha: verified } = await seam.commitBranch(
      iso.cwd,
      'node/seal-result',
      'pleach: seal-node verified (done)',
    );
    expect(await gitIn(iso.cwd, 'rev-parse', `${verified}^`)).toBe(sha);
    // The sealed commit holds the test and NOT the implementation that followed.
    const sealed = await gitIn(iso.cwd, 'show', '--stat', '--format=', sha);
    expect(sealed).toContain('red.test.txt');
    expect(sealed).not.toContain('impl.txt');

    await iso.dispose();
  } finally {
    await repo.cleanup();
  }
});

// ledger: dispose — worktree gone after dispose; second dispose does not throw
test('ledger: dispose — worktree removed; second dispose is a no-op', async () => {
  const repo = await createRepo();
  try {
    await makeBranch(repo.path, 'node/dispose-base', { 'dispose.txt': 'bye\n' });

    const seam = createIsolateSeam(execLocal, repo.path);
    const node = { id: 'dispose-node', needs: [], work: { prompt: 'x' } } as never;

    const iso = await seam.isolate(node, ['node/dispose-base']);
    const worktreePath = iso.cwd;

    await iso.dispose();

    // Should no longer be in worktree list
    const { output } = await execLocal(
      ['git', '-C', repo.path, 'worktree', 'list', '--porcelain'],
      { cwd: repo.path },
    );
    expect(output).not.toContain(worktreePath);

    // Second dispose must not throw
    await expect(iso.dispose()).resolves.toBeUndefined();
  } finally {
    await repo.cleanup();
  }
});

// ── lead review fixes ────────────────────────────────────────────────────────

// ledger: C1 — a marker gate that cannot run must throw, never report clean
test('lead-review: scanMarkers on a non-repo path throws IsolateCatastrophicError', async () => {
  const { exec } = await import('../../src/seams/exec.ts');
  const seam = createIsolateSeam(exec, '/nonexistent-pleach-repo');
  await expect(seam.scanMarkers('/nonexistent-pleach-dir')).rejects.toThrow(
    IsolateCatastrophicError,
  );
});

test('lead-review: stage into a non-repo path throws IsolateCatastrophicError (typed)', async () => {
  const { exec } = await import('../../src/seams/exec.ts');
  const seam = createIsolateSeam(exec, '/nonexistent-pleach-repo');
  await expect(seam.stage('/nonexistent-pleach-dir', ['x.txt'])).rejects.toThrow(
    IsolateCatastrophicError,
  );
});

// ── Finding A: dispose must remove tmpBase, not just the wt/ subdir ────────────────────────────

// After dispose(), the parent mkdtemp dir (tmpBase = dirname(iso.cwd)) must not exist.
// With the bug, git worktree remove only deletes wt/ and tmpBase is left as an empty dir.
test('dispose: tmpBase parent dir is removed after dispose', async () => {
  const repo = await createRepo();
  try {
    await makeBranch(repo.path, 'node/dispose-tmpbase', { 'f.txt': 'hi\n' });
    const seam = createIsolateSeam(execLocal, repo.path);
    const node = { id: 'dispose-tmpbase', needs: [], work: { prompt: 'x' } } as never;

    const iso = await seam.isolate(node, ['node/dispose-tmpbase']);
    // iso.cwd is tmpBase/wt — tmpBase is the parent
    const tmpBase = join(iso.cwd, '..');

    await iso.dispose();

    // tmpBase must be gone after dispose; access() rejects when path does not exist
    await expect(access(tmpBase)).rejects.toThrow();
  } finally {
    await repo.cleanup();
  }
});

// If git worktree remove exits non-zero for an unrecognized reason, it must not
// be swallowed — it should surface as an IsolateCatastrophicError.
test('dispose: unrecognized git worktree remove failure surfaces as IsolateCatastrophicError', async () => {
  const repo = await createRepo();
  try {
    await makeBranch(repo.path, 'node/dispose-err', { 'e.txt': 'err\n' });
    // Inject an exec that fails `git worktree remove` with an unrecognized error
    // (not the tolerated "is not a working tree" / "not found"); everything else
    // runs for real, so the worktree is created normally and only remove fails.
    const spoofExec: ExecFn = async (argv, opts) => {
      if (argv.includes('worktree') && argv.includes('remove')) {
        return { output: 'catastrophic unrecognized failure', stdout: '', exitCode: 128 };
      }
      return execLocal(argv, opts);
    };
    const seam = createIsolateSeam(spoofExec, repo.path);
    const node = { id: 'dispose-err', needs: [], work: { prompt: 'x' } } as never;
    const iso = await seam.isolate(node, ['node/dispose-err']);

    await expect(iso.dispose()).rejects.toThrow(IsolateCatastrophicError);

    // dispose threw before its own tmpBase cleanup ran — remove the orphan.
    await rm(join(iso.cwd, '..'), { recursive: true, force: true });
  } finally {
    await repo.cleanup();
  }
});

// ledger: S1/C2 — staging fallback: actual changes only, gitignored junk excluded
test('lead: changedFiles lists modified + untracked-unignored, never ignored junk', async () => {
  const { exec } = await import('../../src/seams/exec.ts');
  const repo = await mkdtemp(join(tmpdir(), 'pleach-cf-'));
  const run = async (...args: string[]) => {
    const r = await exec(['git', '-C', repo, ...args], { cwd: repo });
    if (r.exitCode !== 0) throw new Error(r.output);
  };
  try {
    await run('init', '-q');
    await run('config', 'user.email', 't@t');
    await run('config', 'user.name', 't');
    await writeFile(join(repo, 'a.txt'), 'one\n');
    await writeFile(join(repo, '.gitignore'), 'junk/\n');
    await run('add', '-A');
    await run('commit', '-q', '-m', 'init');

    await writeFile(join(repo, 'a.txt'), 'two\n'); // modified tracked
    await writeFile(join(repo, 'b.txt'), 'new\n'); // untracked unignored
    await mkdir(join(repo, 'junk'), { recursive: true });
    await writeFile(join(repo, 'junk', 'x.bin'), 'zzz'); // ignored
    await mkdir(join(repo, 'fresh'), { recursive: true });
    await writeFile(join(repo, 'fresh', 'c.txt'), 'new\n'); // untracked, new dir

    const seam = createIsolateSeam(exec, repo);
    const files = await seam.changedFiles(repo);
    expect(files).toContain('a.txt');
    expect(files).toContain('b.txt');
    expect(files.some((f) => f.startsWith('junk'))).toBe(false);
    // A directory git has never seen is still named file by file: this list is
    // the staged set every per-file check reads (D13's seal record, the
    // receipt count, audit-gate tampering), and "fresh/" names nothing.
    expect(files).toContain('fresh/c.txt');
    expect(files).not.toContain('fresh/');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ledger: D14 — the friction journal is read out of the tree at settle, so the
// read is proven against a real directory: the month files, in name order,
// and nothing else the ledger keeps beside them.
test('readFriction concatenates the month files in name order, and only those', async () => {
  const { exec } = await import('../../src/seams/exec.ts');
  const tree = await mkdtemp(join(tmpdir(), 'pleach-friction-'));
  const friction = join(tree, '.plotplot', 'friction');
  try {
    const seam = createIsolateSeam(exec, tree);
    // No `.plotplot/friction/` at all — the common case.
    expect(await seam.readFriction(tree)).toBeNull();

    await mkdir(join(friction, 'state'), { recursive: true });
    await writeFile(join(friction, 'hotspots.json'), '{"src/loop/run-plan.ts":3}\n');
    await writeFile(join(friction, 'state', 'cursor.jsonl'), '{"seen":41}\n');
    // A directory the ledger has written to, but no journal in it yet.
    expect(await seam.readFriction(tree)).toBeNull();

    // Written newest-first: the answer is name order, not creation order.
    await writeFile(join(friction, '2026-09.jsonl'), '{"at":"2026-09-02"}\n');
    await writeFile(join(friction, '2026-08.jsonl'), '{"at":"2026-08-30"}\n');
    expect(await seam.readFriction(tree)).toBe('{"at":"2026-08-30"}\n{"at":"2026-09-02"}\n');
  } finally {
    await rm(tree, { recursive: true, force: true });
  }
});

// ledger: D17 — a resumed node's prompt names what the interrupted attempt was
// holding, and that stat comes from real git. Proven against a real quarantine
// commit: the file list and totals of what THAT commit introduced, never the
// whole tree, and null where there is nothing to show.
test('commitStat shows what a commit introduced, and nothing else', async () => {
  const repo = await createRepo();
  try {
    await makeBranch(repo.path, 'node/stat-base', { 'kept.txt': 'kept\n' });

    const seam = createIsolateSeam(execLocal, repo.path);
    const node = { id: 'stat-node', needs: [], work: { prompt: 'x' } } as never;
    const iso = await seam.isolate(node, ['node/stat-base']);

    // The tree an interrupted attempt left behind, quarantined as it stands.
    await writeFile(join(iso.cwd, 'wip.txt'), 'one\ntwo\n');
    await seam.stage(iso.cwd, ['wip.txt']);
    const { sha } = await seam.commitBranch(iso.cwd, 'quarantine/stat-node', 'pleach: quarantined');

    const stat = await seam.commitStat(repo.path, 'quarantine/stat-node');
    expect(stat).not.toBeNull();
    expect(stat).toContain('wip.txt');
    expect(stat).toContain('2 +');
    expect(stat).toContain('1 file changed');
    // The base's own file is in the tree but not in this commit.
    expect(stat).not.toContain('kept.txt');
    // The sha answers exactly as the branch does.
    expect(await seam.commitStat(repo.path, sha)).toBe(stat as string);

    // A commit that introduced nothing, and a ref that does not resolve, are
    // the same answer: there is no stat to show.
    const { sha: empty } = await seam.commitBranch(
      iso.cwd,
      'quarantine/stat-empty',
      'pleach: none',
    );
    expect(await seam.commitStat(repo.path, empty)).toBeNull();
    expect(await seam.commitStat(repo.path, 'refs/heads/no-such-branch')).toBeNull();

    await iso.dispose();
  } finally {
    await repo.cleanup();
  }
});
