// Ledger D21 (jahala/pleach#97): the stem's run journal lost nineteen nodes
// between two runs while the receipts beside it survived — one unguarded file
// was the record of record. The receipts are the witness: they are written per
// close and sealed. On `run-start`, every receipt whose node has no `verdict`
// line in the journal is journaled as `journal-gap` {node, receiptSha256,
// closedAt}, so a vanished record is visible the next time anyone runs. A
// complete journal journals none, and the check never fails the run.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { mintReceipt, type Receipt } from '../../src/core/receipt.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, makeHarness } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };

// This run builds z; a and b closed in an earlier run of another plan. The
// journal and the receipts are one per repository, never per plan.
function plan() {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [{ id: 'z', work: { prompt: 'build z' }, policy: { maxAttempts: 1 } }],
  });
}

function receiptFor(node: string): Receipt {
  return mintReceipt({
    node,
    source: 'earlier',
    status: 'done',
    attempts: 1,
    provider: 'claude',
    gates: [],
    acceptance: {},
    degraded: ['smoke:unconfigured', 'audit:unconfigured'],
    stagedFiles: 1,
    telemetry: {},
    durationMs: 1,
    pleachVersion: '0.0.1-test',
  });
}

// An earlier run's lines as they stood in the file: `verdictsFor` names the
// nodes whose verdict line survived. Every node's other lines are there, so
// only the verdict line tells a recorded close from a lost one.
function earlierRun(h: Harness, nodes: string[], verdictsFor: string[]): void {
  h.journal.push({ event: 'run-start', goal: 'earlier', nodes: nodes.length });
  for (const node of nodes) {
    h.journal.push({ event: 'node-start', node });
    if (verdictsFor.includes(node)) {
      h.journal.push({ event: 'verdict', node, status: 'done', attempts: 1, spawned: true });
    }
    h.journal.push({ event: 'receipt', node, sha256: h.receipts.get(node)?.sha256 });
  }
  h.journal.push({ event: 'run-end' });
}

function gaps(h: Harness): Record<string, unknown>[] {
  return h.journal.filter((e) => e.event === 'journal-gap');
}

describe('the receipts witness the journal on run-start (D21)', () => {
  // ledger: D21
  test('a receipt whose node has no verdict line is journaled as a gap, once', async () => {
    const a = receiptFor('a');
    const b = receiptFor('b');
    const h = makeHarness({ receiptsSeed: { a, b } });
    earlierRun(h, ['a', 'b'], ['a']);
    const before = h.journal.length;

    const summary = await runPlan(plan(), h.deps, OPTS);

    expect(summary.closed).toEqual(['z']);
    const found = gaps(h);
    expect(found).toHaveLength(1);
    const gap = found[0] as Record<string, unknown>;
    expect(gap.node).toBe('b');
    expect(gap.receiptSha256).toBe(b.sha256);
    expect(typeof gap.closedAt).toBe('string');
    expect(Number.isNaN(Date.parse(gap.closedAt as string))).toBe(false);
    // On run-start: after this run's start line, before any node is dispatched.
    const run = h.journal.slice(before);
    const at = run.indexOf(gap);
    expect(run[0]?.event).toBe('run-start');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(run.findIndex((e) => e.event === 'node-start'));
  });

  // ledger: D21
  test('a complete journal journals no gap', async () => {
    const h = makeHarness({ receiptsSeed: { a: receiptFor('a'), b: receiptFor('b') } });
    earlierRun(h, ['a', 'b'], ['a', 'b']);

    const summary = await runPlan(plan(), h.deps, OPTS);

    expect(summary.closed).toEqual(['z']);
    expect(gaps(h)).toEqual([]);
  });

  // ledger: D21
  test("the loop's own record is complete: a second run over the first journals no gap", async () => {
    const h = makeHarness();

    await runPlan(plan(), h.deps, OPTS);
    expect(h.receipts.has('z')).toBe(true);
    await runPlan(plan(), h.deps, OPTS);

    expect(gaps(h)).toEqual([]);
  });

  // ledger: D21
  test('a receipt store that cannot be listed is journaled, and the run goes on', async () => {
    const h = makeHarness({
      receiptsSeed: { b: receiptFor('b') },
      receiptsListThrows: new Error("EACCES: permission denied, scandir '/r/.git/pleach/receipts'"),
    });

    const summary = await runPlan(plan(), h.deps, OPTS);

    expect(summary.closed).toEqual(['z']);
    expect(gaps(h)).toEqual([]);
    const failed = h.journal.filter((e) => e.event === 'journal-gap-check-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail).toContain('EACCES');
  });
});
