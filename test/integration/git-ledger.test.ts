// gitLedger adapter integration test — uses real git repos in tmp dirs, no mocks.
import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitLedger } from '../../src/adapters/git.ts';
import { LedgerError } from '../../src/core/errors.ts';
import type { Verdict } from '../../src/core/plan.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

const execLocal = async (
  argv: string[],
  cwd: string,
): Promise<{ output: string; exitCode: number }> => {
  const proc = Bun.spawn(argv, {
    cwd,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { output: out + err, exitCode };
};

async function gitIn(repo: string, ...args: string[]): Promise<string> {
  const r = await execLocal(['git', '-C', repo, ...args], repo);
  if (r.exitCode !== 0) {
    throw new Error(`git -C ${repo} ${args.join(' ')} exited ${r.exitCode}:\n${r.output}`);
  }
  return r.output.trim();
}

async function createRepo(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'pleach-gl-'));
  await execLocal(['git', 'init', path], tmpdir());
  await gitIn(path, 'config', 'user.email', 'test@pleach.test');
  await gitIn(path, 'config', 'user.name', 'Pleach Test');
  // Initial commit so we can create branches
  await writeFile(join(path, 'init.txt'), 'init\n');
  await gitIn(path, 'add', 'init.txt');
  await gitIn(path, 'commit', '-m', 'initial');
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

/** Create a branch, make a commit on it, return to the default branch. Returns the commit SHA. */
async function makeBranch(repo: string, branch: string): Promise<string> {
  await gitIn(repo, 'checkout', '-b', branch);
  await writeFile(join(repo, `${branch.replace(/\//g, '-')}.txt`), `${branch}\n`);
  await gitIn(repo, 'add', '-A');
  await gitIn(repo, 'commit', '-m', `branch ${branch}`);
  const sha = await gitIn(repo, 'rev-parse', 'HEAD');
  const branches = (await execLocal(['git', '-C', repo, 'branch'], repo)).output;
  const defaultBranch = branches.includes('master') ? 'master' : 'main';
  await gitIn(repo, 'checkout', defaultBranch);
  return sha;
}

// ── tests ─────────────────────────────────────────────────────────────────────

// (a) repo with node/* branches + a non-node branch → Map has exactly the node ids, SHA correct
test('gitLedger: readClosed returns Map of node ids → SHAs, strips node/ prefix, excludes non-node branches', async () => {
  const repo = await createRepo();
  try {
    const shaFoo = await makeBranch(repo.path, 'node/foo');
    const shaBar = await makeBranch(repo.path, 'node/bar');
    await makeBranch(repo.path, 'feature/x'); // must be excluded

    const ledger = gitLedger({ repo: repo.path });
    const closed = await ledger.readClosed('ignored-source');

    expect(closed.size).toBe(2);
    expect(closed.get('foo')).toBe(shaFoo);
    expect(closed.get('bar')).toBe(shaBar);
    // node/ prefix must be stripped from keys
    expect(closed.has('node/foo')).toBe(false);
    expect(closed.has('node/bar')).toBe(false);
    // feature branch must not appear
    expect(closed.has('feature/x')).toBe(false);
    expect(closed.has('x')).toBe(false);
  } finally {
    await repo.cleanup();
  }
});

// (b) repo with NO node/* branches → empty Map
test('gitLedger: readClosed returns empty Map when no node/* branches exist', async () => {
  const repo = await createRepo();
  try {
    // Only the default branch exists (no node/* branches)
    const ledger = gitLedger({ repo: repo.path });
    const closed = await ledger.readClosed('ignored-source');

    expect(closed.size).toBe(0);
    expect(closed instanceof Map).toBe(true);
  } finally {
    await repo.cleanup();
  }
});

// (c) emitVerdict: done → { closed: true }; failed/dead/aborted → { closed: false }
test('gitLedger: emitVerdict returns { closed: true } for done, { closed: false } for non-done', async () => {
  const repo = await createRepo();
  try {
    const ledger = gitLedger({ repo: repo.path });

    const base: Omit<Verdict, 'status'> = {
      node: 'test-node',
      output: null,
      evidence: { filesTouched: [] },
      telemetry: {},
      attempts: 1,
    };

    const doneVerdict: Verdict = { ...base, status: 'done' };
    const failedVerdict: Verdict = { ...base, status: 'failed' };
    const deadVerdict: Verdict = { ...base, status: 'dead' };
    const abortedVerdict: Verdict = { ...base, status: 'aborted' };

    expect(await ledger.emitVerdict(doneVerdict, 'ignored')).toEqual({ closed: true });
    expect(await ledger.emitVerdict(failedVerdict, 'ignored')).toEqual({ closed: false });
    expect(await ledger.emitVerdict(deadVerdict, 'ignored')).toEqual({ closed: false });
    expect(await ledger.emitVerdict(abortedVerdict, 'ignored')).toEqual({ closed: false });
  } finally {
    await repo.cleanup();
  }
});

// (d) readClosed on a non-git directory → throws LedgerError
test('gitLedger: readClosed on a non-git directory throws LedgerError', async () => {
  const nonGitDir = await mkdtemp(join(tmpdir(), 'pleach-not-git-'));
  try {
    const ledger = gitLedger({ repo: nonGitDir });
    await expect(ledger.readClosed('ignored')).rejects.toThrow(LedgerError);
  } finally {
    await rm(nonGitDir, { recursive: true, force: true });
  }
});
