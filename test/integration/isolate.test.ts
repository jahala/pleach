/**
 * Integration tests for src/seams/isolate.ts
 *
 * Uses REAL git repos built in mkdtemp dirs. No mocks.
 * Local ExecFn helper (Bun.spawn arg-arrays) is defined here per agent protocol:
 * the exec seam PR has not merged yet.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    exitCode: killed ? 1 : exitCode,
  };
};

// ── Git repo helpers ────────────────────────────────────────────────────────

interface Repo {
  path: string;
  cleanup: () => Promise<void>;
}

async function git(repoPath: string, ...args: string[]): Promise<string> {
  const result = await execLocal(['git', '-C', repoPath, ...args], { cwd: repoPath });
  if (result.exitCode !== 0) {
    throw new Error(`git -C ${repoPath} ${args.join(' ')} exited ${result.exitCode}:\n${result.output}`);
  }
  return result.output.trim();
}

async function createRepo(): Promise<Repo> {
  const path = await mkdtemp(join(tmpdir(), 'pleach-test-'));
  await git(path, 'init');
  await git(path, 'config', 'user.email', 'test@pleach.test');
  await git(path, 'config', 'user.name', 'Pleach Test');

  // Initial commit on main
  await writeFile(join(path, 'initial.txt'), 'initial\n');
  await git(path, 'add', 'initial.txt');
  await git(path, 'commit', '-m', 'initial');

  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}

/** Create a branch off HEAD, write a file, commit, return to previous branch. */
async function makeBranch(
  repoPath: string,
  branch: string,
  files: Record<string, string>,
): Promise<void> {
  await git(repoPath, 'checkout', '-b', branch);
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(repoPath, name);
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    if (dir !== repoPath) await mkdir(dir, { recursive: true });
    await writeFile(filePath, content);
  }
  await git(repoPath, 'add', '-A');
  await git(repoPath, 'commit', '-m', `branch ${branch}`);
  await git(repoPath, 'checkout', 'master', '--').catch(() =>
    git(repoPath, 'checkout', 'main', '--'),
  );
}

// ── Test suite ──────────────────────────────────────────────────────────────

let repo: Repo;
beforeAll(async () => {
  repo = await createRepo();
});
afterAll(async () => {
  await repo.cleanup();
});

// spec §6 — fan-out: two detached worktrees off one ref concurrently
test('spec: fan-out — two concurrent isolates off one ref succeed without conflict', async () => {
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

  // No "already checked out" error — both succeed
  expect(isoA.cwd).not.toBe(isoB.cwd);

  await isoA.dispose();
  await isoB.dispose();
});

// ledger: B3/C1 — join with conflict: markers kept, conflictFiles populated
test('ledger: B3/C1 — join-with-conflict keeps markers, conflictFiles populated', async () => {
  // Both branches modify the same line of the same file — guaranteed conflict
  await git(repo.path, 'checkout', '-b', 'node/conflict-A');
  await writeFile(join(repo.path, 'shared.txt'), 'version A\n');
  await git(repo.path, 'add', 'shared.txt');
  await git(repo.path, 'commit', '-m', 'A version');

  await git(repo.path, 'checkout', 'master', '--').catch(() =>
    git(repo.path, 'checkout', 'main', '--'),
  );
  await git(repo.path, 'checkout', '-b', 'node/conflict-B');
  await writeFile(join(repo.path, 'shared.txt'), 'version B\n');
  await git(repo.path, 'add', 'shared.txt');
  await git(repo.path, 'commit', '-m', 'B version');

  await git(repo.path, 'checkout', 'master', '--').catch(() =>
    git(repo.path, 'checkout', 'main', '--'),
  );

  const seam = createIsolateSeam(execLocal, repo.path);
  const node = { id: 'conflict-node', needs: [], work: { prompt: 'x' } } as never;

  const iso = await seam.isolate(node, ['node/conflict-A', 'node/conflict-B']);

  expect(iso.conflictFiles).toContain('shared.txt');
  const content = await Bun.file(join(iso.cwd, 'shared.txt')).text();
  expect(content).toContain('<<<<<<<');

  await iso.dispose();
});

// spec §6 — clean join: disjoint files, no conflict
test('spec: clean join — disjoint files, empty conflictFiles', async () => {
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
});

// ledger: B1 — missing baseRef → IsolateCatastrophicError + no leftover worktree
test('ledger: B1 — missing non-first ref → IsolateCatastrophicError, no leftover worktree', async () => {
  await makeBranch(repo.path, 'node/exist-ref', { 'exist.txt': 'exists\n' });

  const seam = createIsolateSeam(execLocal, repo.path);
  const node = { id: 'missing-ref', needs: [], work: { prompt: 'x' } } as never;

  await expect(
    seam.isolate(node, ['node/exist-ref', 'node/ghost-does-not-exist']),
  ).rejects.toThrow(IsolateCatastrophicError);

  // No leftover worktree
  const { output } = await execLocal(['git', '-C', repo.path, 'worktree', 'list', '--porcelain'], {
    cwd: repo.path,
  });
  // Should only contain the main worktree, not a tmp path with "pleach-" in it
  const tmpWorktrees = output
    .split('\n')
    .filter((l) => l.startsWith('worktree ') && l.includes('pleach-'));
  expect(tmpWorktrees).toHaveLength(0);
});

// ledger: C1 — scanMarkers: conflicted worktree returns file; after resolution returns []
test('ledger: C1 — scanMarkers returns conflicted file; clean after resolution', async () => {
  await git(repo.path, 'checkout', '-b', 'node/scan-A');
  await writeFile(join(repo.path, 'scan.txt'), 'scan version A\n');
  await git(repo.path, 'add', 'scan.txt');
  await git(repo.path, 'commit', '-m', 'scan A');

  await git(repo.path, 'checkout', 'master', '--').catch(() =>
    git(repo.path, 'checkout', 'main', '--'),
  );
  await git(repo.path, 'checkout', '-b', 'node/scan-B');
  await writeFile(join(repo.path, 'scan.txt'), 'scan version B\n');
  await git(repo.path, 'add', 'scan.txt');
  await git(repo.path, 'commit', '-m', 'scan B');

  await git(repo.path, 'checkout', 'master', '--').catch(() =>
    git(repo.path, 'checkout', 'main', '--'),
  );

  const seam = createIsolateSeam(execLocal, repo.path);
  const node = { id: 'scan-node', needs: [], work: { prompt: 'x' } } as never;

  const iso = await seam.isolate(node, ['node/scan-A', 'node/scan-B']);

  // Markers present — scanMarkers should find them
  const dirty = await seam.scanMarkers(iso.cwd);
  expect(dirty).toContain('scan.txt');

  // Write resolved content (no markers)
  await writeFile(join(iso.cwd, 'scan.txt'), 'resolved content\n');
  const clean = await seam.scanMarkers(iso.cwd);
  expect(clean).toEqual([]);

  await iso.dispose();
});

// ledger: S1 — scoped stage: junk file excluded, only named files committed
test('ledger: S1 — scoped stage only commits the given files, not junk', async () => {
  await makeBranch(repo.path, 'node/stage-base', { 'real.txt': 'real content\n' });

  const seam = createIsolateSeam(execLocal, repo.path);
  const node = { id: 'stage-node', needs: [], work: { prompt: 'x' } } as never;

  const iso = await seam.isolate(node, ['node/stage-base']);

  // Write a real change and junk (like node_modules-ish.txt)
  await writeFile(join(iso.cwd, 'real.txt'), 'real updated\n');
  await writeFile(join(iso.cwd, 'node_modules-ish.txt'), 'junk\n');

  // Stage only the real file
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
});

// ledger: B2 — commitBranch returns sha; refSha matches; allow-empty works
test('ledger: B2 — commitBranch returns sha; allow-empty succeeds; refSha resolves', async () => {
  await makeBranch(repo.path, 'node/commit-base', { 'committed.txt': 'committed\n' });

  const seam = createIsolateSeam(execLocal, repo.path);
  const node = { id: 'commit-node', needs: [], work: { prompt: 'x' } } as never;

  const iso = await seam.isolate(node, ['node/commit-base']);

  // Stage something
  await writeFile(join(iso.cwd, 'committed.txt'), 'updated\n');
  await seam.stage(iso.cwd, ['committed.txt']);
  const { sha } = await seam.commitBranch(iso.cwd, 'node/commit-result', 'test commit');

  expect(typeof sha).toBe('string');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);

  // refSha from the worktree dir resolves to the same sha
  const resolved = await seam.refSha(iso.cwd, 'node/commit-result');
  expect(resolved).toBe(sha);

  // allow-empty: nothing staged — must still succeed
  const { sha: sha2 } = await seam.commitBranch(iso.cwd, 'node/empty-result', 'empty commit');
  expect(sha2).toMatch(/^[0-9a-f]{40}$/);

  await iso.dispose();
});

// ledger: dispose — worktree gone after dispose; second dispose does not throw
test('ledger: dispose — worktree removed; second dispose is a no-op', async () => {
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
});
