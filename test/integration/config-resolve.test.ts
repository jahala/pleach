// config-resolve integration test — uses real tmp git repos + fixture configs; no mocks.
import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '../../src/core/errors.ts';
import { resolveSeams } from '../../src/faces/config.ts';

// ── git helpers (reused from git-ledger.test.ts pattern) ─────────────────────

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
  const path = await mkdtemp(join(tmpdir(), 'pleach-cr-'));
  await execLocal(['git', 'init', path], tmpdir());
  await gitIn(path, 'config', 'user.email', 'test@pleach.test');
  await gitIn(path, 'config', 'user.name', 'Pleach Test');
  // Initial commit so we can create branches
  await writeFile(join(path, 'init.txt'), 'init\n');
  await gitIn(path, 'add', 'init.txt');
  await gitIn(path, 'commit', '-m', 'initial');
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

/** Create a node/<branch> branch, commit to it, return to default branch. */
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

// ── fixture paths ─────────────────────────────────────────────────────────────

const CUSTOM_CONFIG = new URL('../fixtures/pleach.config.custom.ts', import.meta.url).pathname;
const BAD_CONFIG = new URL('../fixtures/pleach.config.bad.ts', import.meta.url).pathname;

// ── tests ──────────────────────────────────────────────────────────────────────

// (a) custom config → custom ledger is used (sentinel key present in readClosed result)
test('resolveSeams: explicit config path → custom ledger selected (sentinel key present)', async () => {
  const repo = await createRepo();
  try {
    const { ledger } = await resolveSeams({
      config: CUSTOM_CONFIG,
      repoRoot: repo.path,
      rctrlBin: 'rctrl',
      permissionMode: 'bypassPermissions',
    });
    const closed = await ledger.readClosed('x');
    expect(closed.has('CUSTOM-SENTINEL')).toBe(true);
  } finally {
    await repo.cleanup();
  }
});

// (b) no config, no tendModule → gitLedger default, node/foo branch appears in readClosed
test('resolveSeams: no config → gitLedger default, node/foo branch is returned', async () => {
  const repo = await createRepo();
  try {
    await makeBranch(repo.path, 'node/foo');

    const { ledger } = await resolveSeams({
      repoRoot: repo.path,
      rctrlBin: 'rctrl',
      permissionMode: 'bypassPermissions',
    });
    const closed = await ledger.readClosed('x');
    expect(closed.has('foo')).toBe(true);
  } finally {
    await repo.cleanup();
  }
});

// (c) config path points to a missing file → ConfigError
test('resolveSeams: missing config file → rejects with ConfigError', async () => {
  const repo = await createRepo();
  try {
    await expect(
      resolveSeams({
        config: '/no/such/pleach.config.ts',
        repoRoot: repo.path,
        rctrlBin: 'rctrl',
        permissionMode: 'bypassPermissions',
      }),
    ).rejects.toThrow(ConfigError);
  } finally {
    await repo.cleanup();
  }
});

// (d) config file exists but is invalid (missing ledger) → ConfigError
test('resolveSeams: invalid config (missing ledger) → rejects with ConfigError', async () => {
  const repo = await createRepo();
  try {
    await expect(
      resolveSeams({
        config: BAD_CONFIG,
        repoRoot: repo.path,
        rctrlBin: 'rctrl',
        permissionMode: 'bypassPermissions',
      }),
    ).rejects.toThrow(ConfigError);
  } finally {
    await repo.cleanup();
  }
});
