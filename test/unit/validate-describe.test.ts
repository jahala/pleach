import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { nodeSummaries, validatePlan } from '../../src/core/validate.ts';

// Subject: `pleach validate` should describe the execution plan, not just say
// it parsed — waves (parallel batches) from the toposort and a per-node
// work-type/gates summary, both additive to the existing {valid, order}.

describe('validatePlan — execution waves', () => {
  test('diamond A→{B,C}→D yields ordered parallel waves [[A],[B,C],[D]]', () => {
    const plan = PlanSchema.parse({
      goal: 'g',
      source: 's',
      nodes: [
        { id: 'A', work: { command: 'x' } },
        { id: 'B', needs: ['A'], work: { command: 'x' } },
        { id: 'C', needs: ['A'], work: { command: 'x' } },
        { id: 'D', needs: ['B', 'C'], work: { command: 'x' } },
      ],
    });
    const { order, waves } = validatePlan(plan);
    expect(waves).toEqual([['A'], ['B', 'C'], ['D']]);
    // order stays a valid linearisation, unchanged in shape.
    expect(order).toHaveLength(4);
    expect(order[order.length - 1]).toBe('D');
  });
});

describe('nodeSummaries — per-node work type + gates', () => {
  test('reports the work discriminant and only the gates each node declares', () => {
    const plan = PlanSchema.parse({
      goal: 'g',
      source: 's',
      nodes: [
        { id: 'cmd', work: { command: 'build' }, setup: 'install', accept: { smoke: 'test' } },
        {
          id: 'agent',
          needs: ['cmd'],
          work: { prompt: 'do it' },
          accept: { audit: { command: 'audit', provider: 'codex' } },
        },
      ],
    });
    const sums = nodeSummaries(plan);
    expect(sums.find((s) => s.id === 'cmd')).toEqual({
      id: 'cmd',
      work: 'command',
      gates: ['setup', 'smoke'],
    });
    const agent = sums.find((s) => s.id === 'agent');
    expect(agent?.work).toBe('prompt');
    expect(agent?.gates).toEqual(['audit:codex']);
  });
});
