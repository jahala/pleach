import { describe, expect, test } from 'bun:test';
import type { Plan } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness, makeNode, stop } from './harness.ts';

// issue #70: the plan is re-read at wave boundaries, so a conductor can recast
// an auditor or correct a prompt on a node that has not started — no abort, no
// resume. In-memory seams; the subject is the loop's reload application and
// refusal policy.

const REPO = '/repo';
const SRC = 'garden.tend.html';

function plan(over: Partial<Plan> & { nodes: Plan['nodes'] }): Plan {
  return { goal: 'g', source: SRC, ...over };
}

describe('runPlan — plan reload (issue #70)', () => {
  test('a reload applied while A runs changes what B runs; journal says applied B', async () => {
    // The reload starts returning the edited plan only after A's worker runs —
    // exactly the "while A runs" moment a conductor edits the file.
    let switched = false;
    const h = makeHarness({
      waitScript: (ctx) => {
        if (ctx.node === 'A' && ctx.role === 'build') switched = true;
        return stop();
      },
    });
    const original = plan({
      nodes: [
        makeNode({ id: 'A', work: { prompt: 'build A' } }),
        makeNode({ id: 'B', needs: ['A'], work: { prompt: 'build B' } }),
      ],
    });
    const reloaded = plan({
      nodes: [
        makeNode({ id: 'A', work: { prompt: 'build A' } }),
        makeNode({ id: 'B', needs: ['A'], work: { prompt: 'build B v2' } }),
      ],
    });
    const summary = await runPlan(original, h.deps, {
      repoRoot: REPO,
      defaultTimeoutMs: 1000,
      reloadPlan: async () => (switched ? reloaded : original),
    });

    expect(summary.closed.sort()).toEqual(['A', 'B']);
    // B was launched from the reloaded node: its worker was sent the new prompt.
    const bSend = h.log.of('send').find((e) => e.node === 'B');
    expect(bSend?.detail).toContain('build B v2');
    // The reload was journaled exactly once, naming B as the applied node.
    const reloadedEvents = h.journal.filter((e) => e.event === 'plan-reloaded');
    expect(reloadedEvents).toHaveLength(1);
    expect(reloadedEvents[0]?.applied).toEqual(['B']);
  });

  test('a reload that changes the graph is refused once; the run finishes on the original plan', async () => {
    const h = makeHarness();
    const original = plan({
      nodes: [makeNode({ id: 'A' }), makeNode({ id: 'B', needs: ['A'] })],
    });
    // A node added — a shape move the reload must refuse, not apply.
    const graphChanged = plan({
      nodes: [makeNode({ id: 'A' }), makeNode({ id: 'B', needs: ['A'] }), makeNode({ id: 'C' })],
    });
    const summary = await runPlan(original, h.deps, {
      repoRoot: REPO,
      defaultTimeoutMs: 1000,
      reloadPlan: async () => graphChanged,
    });

    expect(summary.closed.sort()).toEqual(['A', 'B']);
    // C never ran — the original plan is what the run finished on.
    expect(h.log.count('isolate', 'C')).toBe(0);
    // Refused once, not once per scheduler tick.
    const refusals = h.journal.filter((e) => e.event === 'plan-reload-refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.detail).toContain('moved');
  });
});
