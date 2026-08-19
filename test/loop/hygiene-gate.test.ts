// §E in the ladder: hygiene runs after scoped staging, before smoke —
// retryable with evidence, terminal failure quarantines, command nodes exempt
// from empty-diff. In-memory seams; the harness exposes stagedDiff/numstat
// injection per node.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness } from './harness.ts';

const OPTS = { repoRoot: '/r' };

function promptPlan(maxAttempts = 1) {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [{ id: 'x', work: { prompt: 'build x' }, policy: { maxAttempts } }],
  });
}

describe('the hygiene gate in the ladder (§E)', () => {
  test('an agent node with an empty staged set fails retryably with the evidence', async () => {
    const h = makeHarness({ changedByNode: { x: [] } }); // explicit: done on nothing
    const summary = await runPlan(promptPlan(2), h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    expect(h.log.count('spawn:build')).toBe(2); // retried once, evidence carried
    const retried = h.log.of('send').some((e) => e.detail?.includes('no changes'));
    expect(retried).toBe(true);
    expect(h.git.refs.has('node/x')).toBe(false);
  });

  test('a staged secret never publishes; the evidence names the leak', async () => {
    const h = makeHarness({
      changedByNode: { x: ['src/config.ts'] },
      stagedDiffByNode: {
        x: '+++ b/src/config.ts\n+const k = "AKIAIOSFODNN7EXAMPLE";\n',
      },
    });
    const summary = await runPlan(promptPlan(1), h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    expect(h.git.refs.has('node/x')).toBe(false);
    const verdict = h.journal.find((e) => e.event === 'verdict' && e.node === 'x');
    expect(String((verdict?.gate as Record<string, unknown>)?.outputTail)).toContain(
      'AWS access key',
    );
  });

  test('a clean diff sails through to close', async () => {
    const h = makeHarness({
      changedByNode: { x: ['src/x.ts'] },
      stagedDiffByNode: { x: '+++ b/src/x.ts\n+export const x = 1;\n' },
    });
    const summary = await runPlan(promptPlan(1), h.deps, OPTS);
    expect(summary.closed).toEqual(['x']);
  });

  test('command nodes are exempt from empty-diff', async () => {
    const plan = PlanSchema.parse({
      goal: 'g',
      source: 's',
      nodes: [{ id: 'c', work: { command: 'true-cmd' }, policy: { maxAttempts: 1 } }],
    });
    const h = makeHarness();
    const summary = await runPlan(plan, h.deps, OPTS);
    expect(summary.closed).toEqual(['c']);
  });
});
