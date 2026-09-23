/**
 * Integration: `pleach stop <plan>` against the real lock seam and a real
 * process (ledger D16).
 *
 * The drain is a marker beside the run's lock, so the run's scheduler sees it
 * on its very next launch decision. This proves the face's half: the marker is
 * written for the run's (repoRoot, source) — no other — only while a LIVE run
 * holds that lock, and `--now` reaches the holder's pid with SIGINT. The holder
 * is a real child process (test/fixtures/hold-lock.ts) taking the lock through
 * the same seam a run does; nothing here is mocked.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLockSeam } from '../../src/seams/lock.ts';
import { createRepo } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const HOLD_LOCK = join(import.meta.dir, '../fixtures/hold-lock.ts');

const SOURCE = 'integration-stop-source';
const PLAN = {
  goal: 'a plan whose run can be drained',
  source: SOURCE,
  nodes: [{ id: 'only', work: { command: 'bash -lc "echo only > only.txt"' } }],
};

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function pleach(args: string[], cwd: string): Promise<RunResult> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
    cwd,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, stdout, stderr };
}

type Holder = ReturnType<typeof Bun.spawn>;

/** Start the holder and return only once its lock is actually on disk. */
async function startHolder(repo: string, source: string): Promise<Holder> {
  const proc = Bun.spawn(['bun', HOLD_LOCK, repo, source], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const reader = proc.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  const line = new TextDecoder().decode(first.value ?? new Uint8Array());
  if (!line.includes('held')) {
    throw new Error(`hold-lock fixture did not take the lock: ${line}`);
  }
  return proc;
}

/** Every pleach file in the repo's git dir — lock and marker alike. */
async function pleachFiles(repo: string): Promise<string[]> {
  const entries = await readdir(join(repo, '.git'));
  return entries.filter((f) => f.startsWith('pleach-')).sort();
}

describe('pleach stop — the drain marker, through the real lock seam', () => {
  let repo = '';
  let planPath = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();
  let holder: Holder | null = null;

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanup = r.cleanup;
    planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(PLAN));
  });

  afterEach(async () => {
    if (holder !== null && holder.exitCode === null) {
      holder.kill('SIGKILL');
      await holder.exited;
    }
    holder = null;
    await cleanup();
  });

  test('D16: a live run → the marker lands beside its lock and the run is left running', async () => {
    holder = await startHolder(repo, SOURCE);

    const stop = await pleach(['stop', planPath, '--repo-root', repo], repo);
    expect(stop.code).toBe(0);

    // Beside the lock, named by the same (repoRoot, source) — the pairing is
    // what stops a marker and a run from drifting apart.
    const files = await pleachFiles(repo);
    const locks = files.filter((f) => f.endsWith('.lock'));
    expect(locks).toHaveLength(1);
    expect(files).toContain(`${locks[0]}.stop`);

    // And what the run's own scheduler asks is answered yes.
    expect(await createLockSeam().stopRequested(repo, SOURCE)).toBe(true);

    // A drain is not an abort: the holder is untouched.
    expect(holder.exitCode).toBeNull();
  }, 20000);

  test('D16: --now sends SIGINT to the pid the lock names', async () => {
    holder = await startHolder(repo, SOURCE);

    const stop = await pleach(['stop', planPath, '--repo-root', repo, '--now'], repo);
    expect(stop.code).toBe(0);

    // 42 is the fixture's SIGINT exit — only the signal produces it.
    expect(await holder.exited).toBe(42);
    expect(await createLockSeam().stopRequested(repo, SOURCE)).toBe(true);
  }, 20000);

  // ledger: B4 — one conductor per (repo, source): a second run is refused.
  test('B4: run while a live run holds the lock → exit 3, nothing built, the holder untouched', async () => {
    holder = await startHolder(repo, SOURCE);

    const run = await pleach(['run', planPath, '--repo-root', repo], repo);
    expect(run.code).toBe(3);
    expect(run.stderr).toMatch(/run lock held by pid \d+/);
    const branch = Bun.spawnSync([
      'git',
      '-C',
      repo,
      'rev-parse',
      '--verify',
      '--quiet',
      'node/only',
    ]);
    expect(branch.exitCode).not.toBe(0);
    expect(
      (await pleachFiles(repo)).filter((f) => f.startsWith('pleach-') && f.endsWith('.lock')),
    ).toHaveLength(1);
    expect(holder.exitCode).toBeNull();
  }, 20000);

  test('D16: no run holds the lock → exit 3 and no marker', async () => {
    const stop = await pleach(['stop', planPath, '--repo-root', repo], repo);
    expect(stop.code).toBe(3);
    expect(stop.stderr).toMatch(/no run holds the lock/);
    expect(stop.stderr).toContain(SOURCE);

    expect(await pleachFiles(repo)).toEqual([]);
    expect(await createLockSeam().stopRequested(repo, SOURCE)).toBe(false);
  }, 20000);

  test('D16: a stale lock is not a live run → exit 3 and no marker', async () => {
    const dead = await startHolder(repo, SOURCE);
    dead.kill('SIGKILL');
    await dead.exited;
    // The lockfile outlives the killed holder; its pid is now dead.
    expect((await pleachFiles(repo)).filter((f) => f.endsWith('.lock'))).toHaveLength(1);

    const stop = await pleach(['stop', planPath, '--repo-root', repo], repo);
    expect(stop.code).toBe(3);
    expect(stop.stderr).toMatch(/no run holds the lock/);
    expect((await pleachFiles(repo)).some((f) => f.endsWith('.stop'))).toBe(false);
  }, 20000);
});
