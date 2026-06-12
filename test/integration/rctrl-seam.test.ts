import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerSpawnError } from '../../src/core/errors.ts';
import type { ExecFn } from '../../src/loop/deps.ts';
import { createRctrlSeam } from '../../src/seams/rctrl.ts';

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

const RCTRL_BIN =
  process.env.PLEACH_RCTRL_BIN ?? '/Users/jahala/conductor/repos/.pleach-tools/rctrl';
const SKIP = !existsSync(RCTRL_BIN);

// ---------------------------------------------------------------------------
// Minimal ExecFn using Bun.spawn arg-arrays — no shell, no exec.ts dep
// (exec seam is owned by another agent; per the task spec, we define this
// locally inside the test file until that PR merges).
// ---------------------------------------------------------------------------

const localExec: ExecFn = async (argv, opts) => {
  const proc = Bun.spawn(argv as string[], {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  const dec = new TextDecoder();
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      output += dec.decode(value, { stream: true });
    }
  };
  await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  const exitCode = await proc.exited;
  return { output, exitCode };
};

// ---------------------------------------------------------------------------
// Test isolation state
// ---------------------------------------------------------------------------

const RUN_ID = randomBytes(4).toString('hex');
let tmpDir = '';
let projectsDir = '';

const SPAWNED: string[] = [];

function sessionSuffix(label: string): string {
  return `pl${RUN_ID}${label}`;
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'pleach-rctrl-test-'));
  projectsDir = join(tmpDir, 'projects');
});

afterEach(async () => {
  // Kill any sessions we spawned; tolerate already-dead sessions.
  await Promise.all(
    SPAWNED.splice(0).map((n) =>
      Bun.spawn([RCTRL_BIN, 'kill', n], {
        env: { ...process.env, RCTRL_STATE: tmpDir },
        stdout: 'ignore',
        stderr: 'ignore',
      }).exited.catch(() => undefined),
    ),
  );
  // Clean up tmux sessions that may have leaked (rctrl prefixes with rctrl-)
  // by killing the state dir — tmux sessions die when the host process ends
  // anyway, so this is belt-and-suspenders.
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

// ---------------------------------------------------------------------------
// Shared factory for the seam under test
// ---------------------------------------------------------------------------

function makeSeam() {
  // RCTRL_STATE: isolated tmp dir so sessions don't bleed across runs.
  // RCTRL_CLAUDE_BIN: our fake-claude.sh stands in for the real claude binary.
  // FAKE_CLAUDE_JSONL_DIR: fake writes JSONL here instead of ~/.claude/projects/
  // FAKE_CLAUDE_HOOK: fake fires stop.sh at this path (rctrl installs it there).
  return createRctrlSeam(localExec, {
    bin: RCTRL_BIN,
    env: {
      RCTRL_STATE: tmpDir,
      RCTRL_CLAUDE_BIN: join(import.meta.dir, '../fixtures/fake-claude.sh'),
      FAKE_CLAUDE_JSONL_DIR: projectsDir,
    },
  });
}

// ---------------------------------------------------------------------------
// Test 1 — happy path: spawn → send → wait → stop, finalMessage non-empty
// ledger: D2 (input/idle reason map), C4 (untruncated read)
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('rctrl-seam — happy path', () => {
  test('spawnWorker + send + wait returns stop with non-empty finalMessage', async () => {
    const seam = makeSeam();
    const worker = await seam.spawnWorker({ cwd: '/tmp' });
    // Track session so afterEach can kill it
    SPAWNED.push((worker as { _name: string })._name);

    await worker.send('hello fake worker');
    const result = await worker.wait({ timeoutMs: 30_000 });

    expect(result.reason).toBe('stop');
    expect(result.finalMessage.length).toBeGreaterThan(0);
    expect(result.finalMessage).toContain('hello fake worker');
    expect(Array.isArray(result.filesTouched)).toBe(true);
    expect(typeof result.telemetry).toBe('object');

    await worker.kill();
  });
});

// ---------------------------------------------------------------------------
// Test 2 — two-turn conversation: --since prevents stale-stop
// ledger: D2 (threading sinceMtime correctly)
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('rctrl-seam — two-turn conversation', () => {
  test('second wait returns second turn finalMessage; does not settle on first turn stop', async () => {
    const seam = makeSeam();
    const worker = await seam.spawnWorker({ cwd: '/tmp' });
    SPAWNED.push((worker as { _name: string })._name);

    // First turn
    await worker.send('first prompt');
    const r1 = await worker.wait({ timeoutMs: 30_000 });
    expect(r1.reason).toBe('stop');
    expect(r1.finalMessage).toContain('first prompt');

    // Second turn — the --since mechanism must prevent settling on the
    // first turn's stop event (race-free threading).
    await worker.send('second prompt');
    const r2 = await worker.wait({ timeoutMs: 30_000 });
    expect(r2.reason).toBe('stop');
    // finalMessage must reflect the SECOND turn, not the first
    expect(r2.finalMessage).toContain('second prompt');
    expect(r2.finalMessage).not.toContain('first prompt');

    await worker.kill();
  });
});

// ---------------------------------------------------------------------------
// Test 3 — wait timeout
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('rctrl-seam — wait timeout', () => {
  test('wait with short timeout returns reason timeout', async () => {
    // Strategy: spawn a worker with a delay so the fake does NOT fire
    // the stop hook within our tight wait. FAKE_CLAUDE_DELAY (ms) makes it sleep.
    const seam = createRctrlSeam(localExec, {
      bin: RCTRL_BIN,
      env: {
        RCTRL_STATE: tmpDir,
        RCTRL_CLAUDE_BIN: join(import.meta.dir, '../fixtures/fake-claude.sh'),
        FAKE_CLAUDE_JSONL_DIR: projectsDir,
        // 60 000 ms delay — far longer than our 2 s wait
        FAKE_CLAUDE_DELAY: '60000',
      },
    });

    const worker = await seam.spawnWorker({ cwd: '/tmp' });
    SPAWNED.push((worker as { _name: string })._name);

    await worker.send('slow prompt');
    const result = await worker.wait({ timeoutMs: 2_000 });

    expect(result.reason).toBe('timeout');
    expect(result.finalMessage).toBe('');
    expect(result.filesTouched).toEqual([]);

    await worker.kill();
  });
});

// ---------------------------------------------------------------------------
// Test 4 — dead worker: kill tmux session directly, then wait → dead
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('rctrl-seam — dead worker', () => {
  test('worker killed externally returns reason dead', async () => {
    const seam = makeSeam();
    const worker = await seam.spawnWorker({ cwd: '/tmp' });
    const name = (worker as { _name: string })._name;
    SPAWNED.push(name);

    // Do NOT send — just kill the tmux session directly.
    // rctrl names tmux sessions as rctrl-<name>.
    await Bun.spawn(['tmux', 'kill-session', '-t', `rctrl-${name}`], {
      stdout: 'ignore',
      stderr: 'ignore',
    }).exited;

    // wait should detect the dead session and resolve reason: 'dead'
    const result = await worker.wait({ timeoutMs: 10_000 });

    expect(result.reason).toBe('dead');
    expect(result.finalMessage).toBe('');
    expect(result.filesTouched).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — spawn failure: nonexistent cwd → WorkerSpawnError
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('rctrl-seam — spawn failure', () => {
  test('spawnWorker with nonexistent cwd throws WorkerSpawnError', async () => {
    const seam = makeSeam();
    await expect(
      seam.spawnWorker({ cwd: '/this/path/does/not/exist/pleach-test' }),
    ).rejects.toBeInstanceOf(WorkerSpawnError);
  });
});
