// A terminal node failure must not destroy the evidence: the worktree's
// changes are committed to quarantine/<id> BEFORE dispose, journaled, and
// surfaced in RunSummary.quarantined. An unchanged tree quarantines nothing
// (no empty-noise branches). In-memory seams per the testing doctrine.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness } from './harness.ts';

function failingPlan() {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [
      {
        id: 'x',
        work: { prompt: 'build x' },
        accept: { smoke: 'run-smoke' },
        policy: { maxAttempts: 1 },
      },
    ],
  });
}

const OPTS = { repoRoot: '/r' };

describe('quarantine — failed work is preserved before dispose', () => {
  test('smoke-failed node with changes → quarantine/<id> committed before dispose', async () => {
    const h = makeHarness({
      changedByNode: { x: ['src/partial.ts'] },
      execScript: (argv) =>
        argv[0] === 'run-smoke' ? { output: 'boom', exitCode: 1 } : { output: '', exitCode: 0 },
    });

    const summary = await runPlan(failingPlan(), h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    expect(summary.quarantined).toEqual(['x']);
    // The branch exists in the in-memory git…
    expect(h.git.refs.has('quarantine/x')).toBe(true);
    // …and was committed BEFORE the tree was disposed.
    expect(h.log.first('commitBranch', 'quarantine/x')).toBeGreaterThan(-1);
    expect(h.log.first('commitBranch', 'quarantine/x')).toBeLessThan(h.log.first('dispose', 'x'));
    // Journal names it.
    expect(h.journal.some((e) => e.event === 'quarantined' && e.node === 'x')).toBe(true);
  });

  test('a failed node with an unchanged tree quarantines nothing', async () => {
    const h = makeHarness({
      changedByNode: { x: [] }, // explicit: the worker touched nothing
      execScript: (argv) =>
        argv[0] === 'run-smoke' ? { output: 'boom', exitCode: 1 } : { output: '', exitCode: 0 },
    });

    const summary = await runPlan(failingPlan(), h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    expect(summary.quarantined).toEqual([]);
    expect(h.git.refs.has('quarantine/x')).toBe(false);
  });

  test('a verified node never quarantines', async () => {
    const h = makeHarness({ changedByNode: { x: ['src/x.ts'] } });
    const p = PlanSchema.parse({
      goal: 'g',
      source: 's',
      nodes: [{ id: 'x', work: { prompt: 'build x' } }],
    });

    const summary = await runPlan(p, h.deps, OPTS);

    expect(summary.closed).toEqual(['x']);
    expect(summary.quarantined).toEqual([]);
    expect(h.git.refs.has('quarantine/x')).toBe(false);
    expect(h.git.refs.has('node/x')).toBe(true);
  });
});
