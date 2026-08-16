import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { sinkIds } from '../../src/core/validate.ts';

// Subject: sinkIds — the pure computation of which nodes land (ledger B3).
// A sink is a node no other plan node depends on; sinks contain their
// ancestors' work (each node's tree is merged from its deps' branches), so
// landing the sinks lands the whole verified canopy.

function plan(nodes: { id: string; needs?: string[] }[]) {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: nodes.map((n) => ({ id: n.id, work: { command: 'true' }, needs: n.needs ?? [] })),
  });
}

describe('sinkIds', () => {
  test('a chain has one sink — its last node', () => {
    const p = plan([{ id: 'a' }, { id: 'b', needs: ['a'] }, { id: 'c', needs: ['b'] }]);
    expect(sinkIds(p)).toEqual(['c']);
  });

  test('independent nodes are all sinks, in plan order', () => {
    const p = plan([{ id: 'a' }, { id: 'b' }]);
    expect(sinkIds(p)).toEqual(['a', 'b']);
  });

  test('a diamond has one sink — the join', () => {
    const p = plan([
      { id: 'a' },
      { id: 'b', needs: ['a'] },
      { id: 'c', needs: ['a'] },
      { id: 'd', needs: ['b', 'c'] },
    ]);
    expect(sinkIds(p)).toEqual(['d']);
  });

  test('a fan-out with a partial join keeps the stray leg as a second sink', () => {
    const p = plan([
      { id: 'a' },
      { id: 'b', needs: ['a'] },
      { id: 'c', needs: ['a'] },
      { id: 'join', needs: ['b'] },
    ]);
    expect(sinkIds(p)).toEqual(['c', 'join']);
  });
});
