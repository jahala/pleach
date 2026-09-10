// Ledger D16, the drain: `pleach stop <plan>` must end a run at a node
// boundary without racing the scheduler. An operator's stop landed on a
// verdict still spawned a worker and killed it (jahala/pleach#67), because the
// scheduler launches the next ready node in the same tick as the close that
// made it ready — a signal can never be made race-free against that.
//
// So the drain is a marker, not a signal, and the scheduler asks the lock seam
// for it as part of EVERY launch decision: before the first launch, and again
// in the tick of every close. What is already in flight is untouched — it
// settles normally, keeping its work — and the run journals `run-stopped`,
// consumes the marker and ends with the unstarted nodes in `skipped`.
//
// In-memory seams per the testing doctrine: the harness lock is a real
// implementation of the seam, holding the marker as a flag a test can flip
// mid-run. The marker's own file lives in test/integration/stop.test.ts.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, makeHarness, stop } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };

// a → b: b becomes ready exactly when a closes, so a marker that lands during
// a's close is the race #67 lost.
function chainPlan() {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [
      { id: 'a', work: { prompt: 'build a' }, policy: { maxAttempts: 1 } },
      { id: 'b', work: { prompt: 'build b' }, needs: ['a'], policy: { maxAttempts: 1 } },
    ],
  });
}

// a ∥ b, then c: both leaves are genuinely in flight when the marker lands.
function fanInPlan() {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [
      { id: 'a', work: { prompt: 'build a' }, policy: { maxAttempts: 1 } },
      { id: 'b', work: { prompt: 'build b' }, policy: { maxAttempts: 1 } },
      { id: 'c', work: { prompt: 'build c' }, needs: ['a', 'b'], policy: { maxAttempts: 1 } },
    ],
  });
}

function nodeStarts(h: Harness): string[] {
  return h.journal.filter((e) => e.event === 'node-start').map((e) => String(e.node));
}

function journalIndex(h: Harness, event: string): number {
  return h.journal.findIndex((e) => e.event === event);
}

describe('a stop marker drains the scheduler (D16)', () => {
  test('a marker landing on a close launches nothing further and consumes itself', async () => {
    const h: Harness = makeHarness({
      emitDecision: (v) => {
        // The operator's `pleach stop` lands while a's verdict is being
        // written — the tick before the scheduler would launch b.
        if (v.node === 'a') h.stop.requested = true;
        return { closed: v.status === 'done' };
      },
    });

    const summary = await runPlan(chainPlan(), h.deps, { ...OPTS, maxConcurrency: 1 });

    // b was ready the instant a closed, and was never launched.
    expect(nodeStarts(h)).toEqual(['a']);
    expect(h.log.count('spawn:build')).toBe(1);
    expect(summary.skipped).toEqual(['b']);

    // a settled normally — the drain interrupts nothing it was holding.
    expect(summary.closed).toEqual(['a']);
    expect(summary).toMatchObject({ failed: [], aborted: [], quarantined: [] });
    expect(h.git.refs.has('node/a')).toBe(true);
    expect(h.git.refs.has('node/b')).toBe(false);
    expect(h.receipts.has('a')).toBe(true);
    expect(h.log.count('dispose', 'a')).toBe(1);

    // The run says it was stopped, before it says it ended.
    const stoppedAt = journalIndex(h, 'run-stopped');
    expect(stoppedAt).toBeGreaterThan(-1);
    expect(stoppedAt).toBeLessThan(journalIndex(h, 'run-end'));
    // A drain is not an abort: no signal fired, nothing was cut off.
    expect(h.journal.some((e) => e.event === 'run-aborted')).toBe(false);

    // The marker is consumed, so the next run is not stopped before it starts.
    expect(h.stop.cleared).toBe(1);
    expect(h.stop.requested).toBe(false);
  });

  test('a marker already there stops the run before its first launch', async () => {
    const h = makeHarness();
    h.stop.requested = true;

    const summary = await runPlan(chainPlan(), h.deps, { ...OPTS, maxConcurrency: 1 });

    expect(nodeStarts(h)).toEqual([]);
    expect(h.log.count('spawn:build')).toBe(0);
    expect(summary.skipped).toEqual(['a', 'b']);
    expect(summary.closed).toEqual([]);
    expect(journalIndex(h, 'run-stopped')).toBeGreaterThan(-1);
    expect(h.stop.cleared).toBe(1);
    expect(h.stop.requested).toBe(false);
  });

  test('in-flight nodes settle normally after the marker lands', async () => {
    let markerLanded = (): void => {};
    const landed = new Promise<void>((resolve) => {
      markerLanded = resolve;
    });
    const h: Harness = makeHarness({
      // a's wait ends and lands the marker while b is still mid-turn: b must
      // be carried to its own close, not abandoned when the run drains.
      waitScript: (ctx) => {
        if (ctx.node !== 'a') return landed.then(() => stop());
        h.stop.requested = true;
        markerLanded();
        return stop();
      },
    });

    const summary = await runPlan(fanInPlan(), h.deps, { ...OPTS, maxConcurrency: 2 });

    expect(summary.closed).toEqual(['a', 'b']);
    expect(summary.skipped).toEqual(['c']);
    expect(summary).toMatchObject({ failed: [], aborted: [] });
    expect(nodeStarts(h)).toEqual(['a', 'b']);
    expect(h.git.refs.has('node/b')).toBe(true);
    expect(h.log.count('dispose', 'b')).toBe(1);
    expect(journalIndex(h, 'run-stopped')).toBeGreaterThan(-1);
    expect(h.stop.cleared).toBe(1);
  });

  test('with no marker the run is exactly what it was', async () => {
    const h = makeHarness();

    const summary = await runPlan(chainPlan(), h.deps, { ...OPTS, maxConcurrency: 1 });

    expect(summary.closed).toEqual(['a', 'b']);
    expect(summary.skipped).toEqual([]);
    expect(nodeStarts(h)).toEqual(['a', 'b']);
    expect(h.journal.some((e) => e.event === 'run-stopped')).toBe(false);
    // Nothing to consume: a run that was never stopped clears nothing.
    expect(h.stop.cleared).toBe(0);
  });
});
