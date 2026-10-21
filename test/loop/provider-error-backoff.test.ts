// ledger: D34 (#151) — a network/provider error must not burn maxAttempts inside one
// outage. Two nodes once died with `wait:provider-error` twice each (the
// machine's DNS was gone for minutes), settled failed at maxAttempts 2, and
// the run had to be restarted by hand. The fault is the machine's network, not
// a vendor — `--fallback-provider` (dead) does not apply — so a provider error
// is retried within the SAME attempt on an exponential backoff (15 s … 240 s),
// spending an attempt only once that budget is spent.
//
// In-memory seams per the testing doctrine: the harness's worker scripts
// `provider-error`, its sleep port records the waits the loop asked for, and
// the subject is the loop's backoff/abort/settle logic.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import type { WorkerResult } from '../../src/loop/deps.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, makeHarness, stop } from './harness.ts';

// The settle (D35) also sleeps after a stop; it is off here so the sleeps
// these tests count are the backoff's alone.
const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test', settleMs: 0 };
const MSG = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";

function providerError(message = MSG): WorkerResult {
  return { reason: 'provider-error', finalMessage: '', filesTouched: [], message, telemetry: {} };
}

function plan(maxAttempts: number) {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [{ id: 'x', work: { prompt: 'build x' }, policy: { maxAttempts } }],
  });
}

function backoffLines(h: Harness): Record<string, unknown>[] {
  return h.journal.filter((e) => e.event === 'provider-error-backoff');
}

function verdictLine(h: Harness): Record<string, unknown> {
  const line = h.journal.filter((e) => e.event === 'verdict' && e.node === 'x').at(-1);
  if (line === undefined) throw new Error('the settled node journaled no verdict');
  return line;
}

describe('a provider error does not spend an attempt (issue #151)', () => {
  test('two provider errors then a stop close the node with attempts 1 and two waits', async () => {
    const h = makeHarness({
      // spawnIndex counts the fresh workers within the one attempt: two
      // provider-error waits, then a stop.
      waitScript: (ctx) => (ctx.spawnIndex < 2 ? providerError() : stop()),
    });

    const summary = await runPlan(plan(2), h.deps, OPTS);

    expect(summary.closed).toEqual(['x']);
    expect(h.emitted.find((v) => v.node === 'x')?.attempts).toBe(1);

    const lines = backoffLines(h);
    expect(lines.map((e) => e.waitMs)).toEqual([15_000, 30_000]);
    expect(lines.map((e) => e.retry)).toEqual([0, 1]);
    expect(lines.map((e) => e.attempt)).toEqual([1, 1]);
    // The harness recorded exactly those two sleeps, nothing more.
    expect(h.sleeps).toEqual([15_000, 30_000]);
  });

  test('a provider that never recovers settles failed once the budget is spent, and the verdict names the cause', async () => {
    const h = makeHarness({ waitScript: () => providerError() });

    const summary = await runPlan(plan(2), h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    const verdict = h.emitted.find((v) => v.node === 'x');
    expect(verdict?.status).toBe('failed');
    // Attempts are counted as today: two failed attempts, not six.
    expect(verdict?.attempts).toBe(2);
    expect(verdict?.evidence.gate).toEqual({ ran: 'wait:provider-error', exitCode: -1 });
    // The journal line names the cause without the worker transcript.
    expect(verdictLine(h).detail).toBe(`provider error ×6: ${MSG}`);
    // Five waits per attempt, two attempts.
    expect(backoffLines(h)).toHaveLength(10);
  });

  test('an abort during a backoff settles aborted and spends no further wait', async () => {
    const controller = new AbortController();
    const h = makeHarness({
      waitScript: () => providerError(),
      sleepScript: () => {
        controller.abort();
        return Promise.resolve();
      },
    });

    const summary = await runPlan(plan(2), h.deps, { ...OPTS, signal: controller.signal });

    expect(summary.aborted).toEqual(['x']);
    expect(summary.failed).toEqual([]);
    expect(h.emitted.find((v) => v.node === 'x')?.status).toBe('aborted');
    // Only the first wait was journaled before the abort cut it short.
    expect(backoffLines(h)).toHaveLength(1);
    expect(h.sleeps).toEqual([15_000]);
  });
});
