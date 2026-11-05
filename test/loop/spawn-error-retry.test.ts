// issue #177 — a worker spawn that fails before any work started (no tree, no
// tokens) was settled failed after one attempt with `maxAttempts` unused. The
// journal read `{"event":"verdict",...,"status":"failed","attempts":1,...,"gate":
// {"ran":"seam:worker","exitCode":-1,"outputTail":"worker spawn failed: umbel
// spawn exited 1: ... database is locked"}}`, and the conductor reran the whole
// plan --fresh. A spawn error is the runner's fault, never the work's, so it is
// retried within the SAME attempt on the provider-error backoff
// (--provider-backoff-ms, 15 s doubling, five waits); only once the waits are
// spent does the node settle failed, naming the cause. Exit 126 (a sign-in)
// keeps its blocked behaviour (D40, #128).
//
// In-memory seams per the testing doctrine: the harness's runner is scripted to
// throw WorkerSpawnError, its sleep port records the waits the loop asked for,
// and the subject is the loop's spawn-retry/settle logic.
import { describe, expect, test } from 'bun:test';
import { WorkerSpawnError } from '../../src/core/errors.ts';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, makeHarness } from './harness.ts';

// The settle (D35) also sleeps after a stop; it is off here so the sleeps
// these tests count are the spawn retry's alone.
const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test', settleMs: 0 };
const LOCKED = 'database is locked';

function spawnError(): WorkerSpawnError {
  return new WorkerSpawnError(LOCKED, 1);
}

function plan(maxAttempts: number) {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [{ id: 'x', work: { prompt: 'build x' }, policy: { maxAttempts } }],
  });
}

function spawnRetryLines(h: Harness): Record<string, unknown>[] {
  return h.journal.filter((e) => e.event === 'spawn-retry');
}

function verdictLine(h: Harness): Record<string, unknown> {
  const line = h.journal.filter((e) => e.event === 'verdict' && e.node === 'x').at(-1);
  if (line === undefined) throw new Error('the settled node journaled no verdict');
  return line;
}

describe('a spawn error before any work does not spend an attempt (issue #177)', () => {
  test('two spawn errors then a spawn close the node with attempts 1 and two waits', async () => {
    let spawns = 0;
    const h = makeHarness();
    const original = h.deps.runner.spawnWorker;
    h.deps.runner.spawnWorker = async (spec) => {
      spawns += 1;
      if (spawns <= 2) throw spawnError();
      return original(spec);
    };

    const summary = await runPlan(plan(2), h.deps, OPTS);

    expect(summary.closed).toEqual(['x']);
    expect(h.emitted.find((v) => v.node === 'x')?.attempts).toBe(1);

    const lines = spawnRetryLines(h);
    expect(lines.map((e) => e.waitMs)).toEqual([15_000, 30_000]);
    expect(lines.map((e) => e.wait)).toEqual([0, 1]);
    expect(lines.map((e) => e.attempt)).toEqual([1, 1]);
    // The harness recorded exactly those two sleeps, nothing more.
    expect(h.sleeps).toEqual([15_000, 30_000]);
  });

  test('a spawn that always fails settles failed once the budget is spent, naming the cause', async () => {
    const h = makeHarness();
    h.deps.runner.spawnWorker = async () => {
      throw spawnError();
    };

    const summary = await runPlan(plan(2), h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    const verdict = h.emitted.find((v) => v.node === 'x');
    expect(verdict?.status).toBe('failed');
    // A spawn error never spends an attempt: the node settles after one.
    expect(verdict?.attempts).toBe(1);

    // The journal line names the cause without the worker transcript, and the
    // next step points at the runner.
    const line = verdictLine(h);
    expect(line.detail).toContain('worker spawn failed 6 times');
    expect(line.detail).toContain(LOCKED);
    expect(line.nextStep).toContain('check the runner');
    // Five waits in one attempt, not ten — no attempt retry.
    expect(spawnRetryLines(h)).toHaveLength(5);
  });

  test('an abort during the spawn wait settles aborted and spends no further wait', async () => {
    const controller = new AbortController();
    const h = makeHarness({
      sleepScript: () => {
        controller.abort();
        return Promise.resolve();
      },
    });
    h.deps.runner.spawnWorker = async () => {
      throw spawnError();
    };

    const summary = await runPlan(plan(2), h.deps, { ...OPTS, signal: controller.signal });

    expect(summary.aborted).toEqual(['x']);
    expect(summary.failed).toEqual([]);
    expect(h.emitted.find((v) => v.node === 'x')?.status).toBe('aborted');
    // Only the first wait was journaled before the abort cut it short.
    expect(spawnRetryLines(h)).toHaveLength(1);
    expect(h.sleeps).toEqual([15_000]);
  });
});
