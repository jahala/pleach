/**
 * Integration test for the abort half of src/adapters/umbel.ts — ledger D16 (1).
 *
 * Drives the REAL umbel binary with a vendored fake worker that never finishes a
 * turn (test/fixtures/fake-claude-wedged.sh). No mocks: real tmux, real umbel
 * state, real exec seam, real AbortSignal.
 *
 * The defect: when the run's own signal fires, the exec seam SIGKILLs `umbel
 * wait` and the adapter sees a non-zero exit, so it throws `WorkerSeamError` —
 * the loop then has no way to tell "the conductor stopped me" from "the runner
 * broke", the throw skips the hand-back, and run-node's `finally` disposes the
 * tree. The adapter is the only layer that knows its own signal fired, so it is
 * the layer that must answer `reason: 'aborted'`.
 *
 * The negative half matters just as much: every OTHER non-zero exit of `umbel
 * wait` stays a `WorkerSeamError`. The discriminator is whether the signal
 * fired, not whether a signal was supplied.
 *
 * Env contract for the fake worker (see test/integration/umbel-seam.test.ts):
 *   UMBEL_STATE           — umbel state root (exec process env)
 *   UMBEL_CLAUDE_BIN      — the fake binary umbel launches (exec process env)
 *   FAKE_CLAUDE_JSONL_DIR — where the fake writes its .jsonl (worker env via --env)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { createUmbelSeam } from '../../src/adapters/umbel.ts';
import { createUmbelSeam as makeUmbel } from '../../src/adapters/umbel.ts';
import { WorkerSeamError } from '../../src/core/errors.ts';
import { exec } from '../../src/seams/exec.ts';

// ── binary resolution ────────────────────────────────────────────────────────
//
// PLEACH_UMBEL_BIN first, then umbel on PATH — the same ladder src/faces/cli.ts
// uses. Falling back to PATH is what lets this suite actually run on a
// developer machine that has umbel installed; CI has neither and skips loudly.

const UMBEL_BIN = process.env.PLEACH_UMBEL_BIN ?? Bun.which('umbel') ?? '';

const FAKE_CLAUDE_WEDGED = join(import.meta.dir, '../fixtures/fake-claude-wedged.sh');

async function binExists(p: string): Promise<boolean> {
  if (p === '') return false;
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const binPresent = await binExists(UMBEL_BIN);

// ── test-run isolation ───────────────────────────────────────────────────────

let stateDir = '';
let jsonlDir = '';

async function setupState(): Promise<void> {
  stateDir = await mkdtemp(join(tmpdir(), 'pleach-umbel-abort-'));
  jsonlDir = join(stateDir, 'fake-jsonl');
  await mkdir(jsonlDir, { recursive: true });
}

async function teardownState(): Promise<void> {
  if (stateDir) {
    await rm(stateDir, { recursive: true, force: true });
    stateDir = '';
    jsonlDir = '';
  }
}

type Seam = ReturnType<typeof createUmbelSeam>;
type SpawnedWorker = Awaited<ReturnType<Seam['spawnWorker']>>;

function makeSeam(): Seam {
  return makeUmbel(exec, {
    bin: UMBEL_BIN,
    env: {
      UMBEL_STATE: stateDir,
      UMBEL_CLAUDE_BIN: FAKE_CLAUDE_WEDGED,
    },
    workerEnv: {
      FAKE_CLAUDE_JSONL_DIR: jsonlDir,
    },
  });
}

// Is the tmux session behind this worker still there? A killed session keeps a
// tombstone (jahala/umbel#73): `umbel status <name>` still exits 0 and reports
// it dead, so liveness is read from `--json`'s `alive`, never the exit code.
// Not found at all (exit 1, after `kill --purge`) is gone too.
async function sessionAlive(name: string): Promise<boolean> {
  const probe = await exec([UMBEL_BIN, 'status', name, '--json'], {
    cwd: '/tmp',
    env: { UMBEL_STATE: stateDir },
    timeoutMs: 10_000,
  });
  if (probe.exitCode !== 0) return false;
  const sessions = JSON.parse(probe.stdout) as Array<{ name: string; alive: boolean }>;
  const session = sessions.find((s) => s.name === name);
  expect(session).toBeDefined();
  return session?.alive === true;
}

// ── suite ────────────────────────────────────────────────────────────────────

describe.skipIf(!binPresent)('umbel seam — an aborted wait (ledger D16)', () => {
  beforeAll(setupState);
  afterAll(teardownState);

  // ledger: D16 — the run's signal interrupts the wait: the adapter answers
  // `aborted`, promptly, with a complete WorkerResult, and leaves the session
  // for the caller to tear down (teardown never rides the signal that caused it).
  test('the run signal interrupting wait returns reason aborted', async () => {
    const seam = makeSeam();
    let worker: SpawnedWorker | undefined;
    try {
      worker = await seam.spawnWorker({ cwd: '/tmp' });
      await worker.send('a prompt this worker will never finish');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 200);
      const startedAt = Date.now();
      const result = await worker.wait({ timeoutMs: 30_000, signal: controller.signal });
      clearTimeout(timer);
      const elapsedMs = Date.now() - startedAt;

      expect(result.reason).toBe('aborted');
      // Prompt: the abort ends the wait, not umbel's own 30s timeout.
      expect(elapsedMs).toBeLessThan(5_000);
      // A complete WorkerResult — nothing gathered from a killed wait, but every
      // field the loop reads is present.
      expect(result.finalMessage).toBe('');
      expect(result.filesTouched).toEqual([]);
      expect(result.telemetry).toBeDefined();

      // The work is still there to be handed back: the session outlived the
      // aborted wait and the caller can still kill it.
      expect(await sessionAlive(worker.__name)).toBe(true);
      await worker.kill();
      expect(await sessionAlive(worker.__name)).toBe(false);
    } finally {
      await worker?.kill().catch(() => undefined);
    }
  }, 90_000);

  // ledger: D16 — the negative: a non-zero `umbel wait` exit that the run's
  // signal did NOT cause stays a WorkerSeamError. `--timeout -1ms` is a
  // malformed duration the real binary rejects (exit 1, verified 2026-09-10) —
  // it stands for the whole class of runner failures the loop must not mistake
  // for an operator's stop.
  test('a non-zero wait exit with no signal still throws WorkerSeamError', async () => {
    const seam = makeSeam();
    let worker: SpawnedWorker | undefined;
    try {
      worker = await seam.spawnWorker({ cwd: '/tmp' });
      await expect(worker.wait({ timeoutMs: -1 })).rejects.toBeInstanceOf(WorkerSeamError);
    } finally {
      await worker?.kill().catch(() => undefined);
    }
  }, 60_000);

  // ledger: D16 — and the discriminator is that the signal FIRED, not that one
  // was supplied: the same failure under a signal that never aborts still throws.
  test('a non-zero wait exit under an un-fired signal still throws WorkerSeamError', async () => {
    const seam = makeSeam();
    let worker: SpawnedWorker | undefined;
    try {
      worker = await seam.spawnWorker({ cwd: '/tmp' });
      const controller = new AbortController();
      await expect(
        worker.wait({ timeoutMs: -1, signal: controller.signal }),
      ).rejects.toBeInstanceOf(WorkerSeamError);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      await worker?.kill().catch(() => undefined);
    }
  }, 60_000);
});
