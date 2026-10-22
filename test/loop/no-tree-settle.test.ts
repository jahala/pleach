// Ledger D22 / issue #100: a node that never got a worktree settles failed
// with the gate's own reason and no preservation step. The failure path must
// not try to quarantine a tree that was never provisioned — the attempt used to
// read as a second, worse failure ("could not preserve failed work …
// catastrophic isolate failure"), so a reader of the journal could not tell
// whether a tree was lost. This pins the never-isolated half: the isolate seam
// throws before any tree exists, and the settle records the verdict, writes the
// receipt (D11 — no terminal verdict without an artifact), and never emits a
// `quarantine-failed` line.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };

function plan() {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [{ id: 'x', work: { prompt: 'build x' }, policy: { maxAttempts: 1 } }],
  });
}

describe('a node that never got a tree (issue #100)', () => {
  test('settles failed with the isolate gate reason, writes the receipt, and never quarantines', async () => {
    const h = makeHarness({ badRefs: new Set(['HEAD']) });

    const summary = await runPlan(plan(), h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    expect(summary.quarantined).toEqual([]);

    // The verdict names the gate that refused it — the isolate itself, not a
    // preservation failure layered on top.
    const verdict = h.journal.find((e) => e.event === 'verdict' && e.node === 'x');
    expect(verdict?.status).toBe('failed');
    expect((verdict?.gate as Record<string, unknown>)?.ran).toBe('isolate HEAD');
    expect((verdict?.gate as Record<string, unknown>)?.exitCode).toBe(-1);

    // No attempt to preserve a tree that does not exist: no quarantine ref, no
    // `quarantine-failed` line, and the seam was never asked for changed files.
    expect(h.git.refs.has('quarantine/x')).toBe(false);
    expect(h.journal.some((e) => e.event === 'quarantine-failed')).toBe(false);
    expect(h.log.count('changedFiles')).toBe(0);

    // D11: the receipt still writes, with no refs — nothing was preserved
    // because nothing existed to preserve, and that is recorded, not an error.
    const receipt = h.receipts.get('x');
    if (receipt === undefined) throw new Error('never-isolated settle left no receipt');
    expect(receipt.facts.status).toBe('failed');
    expect(receipt.refs).toBeUndefined();
  });
});
