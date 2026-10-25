// issue #85 — `pleach run --only`: run a named subset of a plan. The operator
// names the nodes that matter now, and the loop schedules exactly those plus
// their unclosed transitive dependencies; nothing else runs, so the other nodes
// never surface as skipped or failed. This is the in-memory loop test; the
// real CLI + real git path is test/e2e/run-only.test.ts.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness } from './harness.ts';

const REPO = '/r';

function plan() {
  return PlanSchema.parse({
    goal: 'five nodes, run only the b chain',
    source: 'garden.html',
    nodes: [
      { id: 'a', work: { prompt: 'build a' } },
      { id: 'b', needs: ['a'], work: { prompt: 'build b' } },
      { id: 'c', work: { prompt: 'build c' } },
      { id: 'd', work: { prompt: 'build d' } },
      { id: 'e', work: { prompt: 'build e' } },
    ],
  });
}

describe('runPlan --only (issue #85)', () => {
  test('--only b runs exactly b and its unclosed dependency a; the rest never run or skip', async () => {
    const h = makeHarness();
    const summary = await runPlan(plan(), h.deps, { repoRoot: REPO, only: ['b'] });

    // Only a and b closed; c/d/e are out of scope — never skipped, never failed.
    expect(summary.closed).toEqual(['a', 'b']);
    expect(summary.failed).toEqual([]);
    expect(summary.skipped).toEqual([]);
    expect(summary.blocked).toEqual([]);
    expect(summary.aborted).toEqual([]);
    expect(summary.alreadyVerified).toEqual([]);

    expect(h.log.count('isolate', 'a')).toBe(1);
    expect(h.log.count('isolate', 'b')).toBe(1);
    for (const id of ['c', 'd', 'e']) expect(h.log.count('isolate', id)).toBe(0);

    // The start line carries the named ids and the expanded scope.
    const start = h.journal.find((e) => e.event === 'run-start');
    expect(start?.only).toEqual(['b']);
    expect(start?.scope).toEqual(['a', 'b']);
  });

  test('--only does not reschedule a closed dependency — it is used as a base', async () => {
    const h = makeHarness({
      closed: new Map([['a', 'a'.repeat(40)]]),
      refs: { 'node/a': 'a'.repeat(40) },
    });
    const summary = await runPlan(plan(), h.deps, { repoRoot: REPO, only: ['b'] });

    expect(summary.closed).toEqual(['b']);
    expect(summary.alreadyVerified).toEqual([]); // a was a base, not a directly-reported close of this run
    expect(h.log.count('isolate', 'a')).toBe(0);
    expect(h.log.count('isolate', 'b')).toBe(1);
    expect(h.log.count('isolate', 'c')).toBe(0);
  });
});
