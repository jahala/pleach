// Ledger D11 (bandung's dogfood, P1+P2): no terminal verdict without an
// artifact. A dead worker with a clean tree left NOTHING — no receipt, no
// quarantine, a bare status line; a blocked node's tree was thrown away on
// the false theory that an unfinished turn holds nothing (workers edit files
// mid-turn — 9m40s of work was discarded). Now: the receipt always writes
// (refs attach only when a quarantine commit landed), blocked quarantines
// exactly like failed, and dead verdicts carry what the runner knew.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness, stop } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };

function promptPlan(maxAttempts = 1) {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [{ id: 'x', work: { prompt: 'build x' }, policy: { maxAttempts } }],
  });
}

describe('no terminal verdict without an artifact (D11)', () => {
  test('a dead worker with a clean tree still mints a receipt — no refs, facts intact', async () => {
    const h = makeHarness({
      changedByNode: { x: [] }, // died before producing anything
      waitScript: () => stop({ reason: 'dead' }),
    });

    const summary = await runPlan(promptPlan(1), h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    expect(summary.quarantined).toEqual([]); // nothing to commit — and that's honest
    expect(h.git.refs.has('quarantine/x')).toBe(false);
    const receipt = h.receipts.get('x');
    if (receipt === undefined) throw new Error('dead settle left no receipt');
    expect(receipt.facts.status).toBe('dead');
    expect(receipt.derived).toBe('quarantined');
    expect(receipt.refs).toBeUndefined();
    expect(h.journal.some((e) => e.event === 'receipt' && e.node === 'x')).toBe(true);
  });

  test('a dead verdict names its end and carries the runner detail when supplied', async () => {
    const h = makeHarness({
      changedByNode: { x: [] },
      waitScript: () =>
        stop({ reason: 'dead', paneTail: 'claude exited: session limit hard-stop' }),
    });

    await runPlan(promptPlan(1), h.deps, OPTS);

    const verdict = h.journal.find((e) => e.event === 'verdict' && e.node === 'x');
    expect((verdict?.gate as Record<string, unknown>)?.ran).toBe('wait:dead');
    expect(verdict?.paneTail).toBe('claude exited: session limit hard-stop');
  });

  test('a blocked node quarantines its tree like a failed one — unfinished is not wrong', async () => {
    const h = makeHarness({
      changedByNode: { x: ['src/wip.ts'] }, // real mid-turn work in the tree
      waitScript: () => stop({ reason: 'input', message: 'session limit reached — resets 9:20pm' }),
    });

    const summary = await runPlan(promptPlan(1), h.deps, OPTS);

    expect(summary.blocked).toEqual(['x']);
    expect(summary.quarantined).toEqual(['x']);
    expect(h.git.refs.has('quarantine/x')).toBe(true);
    const receipt = h.receipts.get('x');
    if (receipt === undefined) throw new Error('blocked settle left no receipt');
    expect(receipt.facts.status).toBe('blocked');
    expect(receipt.refs?.quarantineBranch).toBe('quarantine/x');
    // The runner's prompt text travels untouched — the operator reads the cause.
    const blockedEvent = h.journal.find((e) => e.event === 'blocked' && e.node === 'x');
    expect(blockedEvent?.reason).toBe('session limit reached — resets 9:20pm');
  });

  test('a never-isolated failure (catastrophic base ref) still mints a receipt', async () => {
    const plan = PlanSchema.parse({
      goal: 'g',
      source: 's',
      nodes: [{ id: 'x', work: { prompt: 'build x' }, policy: { maxAttempts: 1 } }],
    });
    const h = makeHarness({ badRefs: new Set(['HEAD']) });

    const summary = await runPlan(plan, h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    const receipt = h.receipts.get('x');
    if (receipt === undefined) throw new Error('never-isolated failure left no receipt');
    expect(receipt.facts.status).toBe('failed');
    expect(receipt.refs).toBeUndefined();
  });
});
