import { describe, expect, test } from 'bun:test';
import type { Node, Plan } from '../../src/core/plan.ts';
import { mergeReloadedPlan, planFingerprint } from '../../src/core/reload.ts';

// issue #70: a run re-reads its plan at wave boundaries. The pure decision
// function is the whole policy: what a reload may change, what refuses it, and
// the merged plan it yields. One test per rule. Pure in/out — no fs, no git,
// no processes, no seams.

const SRC = 'garden.tend.html';

function node(id: string, over: Partial<Node> = {}): Node {
  return {
    id,
    worker: {},
    work: { prompt: `build ${id}` },
    needs: [],
    accept: {},
    policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
    closes: [],
    ...over,
  };
}

function plan(over: Partial<Plan> & { nodes: Plan['nodes'] }): Plan {
  return { goal: 'g', source: SRC, ...over };
}

describe('planFingerprint', () => {
  test('the same plan parsed twice fingerprints equal, a change differs', () => {
    const a = plan({ nodes: [node('x')] });
    const b = plan({ nodes: [node('x')] });
    const changed = plan({ nodes: [node('x', { work: { prompt: 'other' } })] });
    expect(planFingerprint(a)).toBe(planFingerprint(b));
    expect(planFingerprint(a)).not.toBe(planFingerprint(changed));
  });
});

describe('mergeReloadedPlan — one rule each', () => {
  test("a pending node's change applies and is named", () => {
    const current = plan({ nodes: [node('a', { work: { prompt: 'v1' } })] });
    const reloaded = plan({ nodes: [node('a', { work: { prompt: 'v2' } })] });
    const decision = mergeReloadedPlan(current, reloaded, new Set());
    expect(decision.kind).toBe('applied');
    if (decision.kind !== 'applied') return;
    expect(decision.applied).toEqual(['a']);
    expect(decision.ignored).toEqual([]);
    expect(decision.plan.nodes[0]?.work).toEqual({ prompt: 'v2' });
  });

  test("a started node's change is ignored and named; the node it started with is kept", () => {
    const current = plan({ nodes: [node('a', { work: { prompt: 'v1' } })] });
    const reloaded = plan({ nodes: [node('a', { work: { prompt: 'v2' } })] });
    const decision = mergeReloadedPlan(current, reloaded, new Set(['a']));
    expect(decision.kind).toBe('applied');
    if (decision.kind !== 'applied') return;
    expect(decision.ignored).toEqual(['a']);
    expect(decision.applied).toEqual([]);
    expect(decision.plan.nodes[0]?.work).toEqual({ prompt: 'v1' });
  });

  test('an added id refuses, naming the move', () => {
    const current = plan({ nodes: [node('a')] });
    const reloaded = plan({ nodes: [node('a'), node('b')] });
    const decision = mergeReloadedPlan(current, reloaded, new Set());
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') expect(decision.detail).toContain('moved');
  });

  test('a removed id refuses', () => {
    const current = plan({ nodes: [node('a'), node('b')] });
    const reloaded = plan({ nodes: [node('a')] });
    expect(mergeReloadedPlan(current, reloaded, new Set()).kind).toBe('refused');
  });

  test('a reordered id refuses', () => {
    const current = plan({ nodes: [node('a'), node('b')] });
    const reloaded = plan({ nodes: [node('b'), node('a')] });
    expect(mergeReloadedPlan(current, reloaded, new Set()).kind).toBe('refused');
  });

  test('a changed needs refuses', () => {
    const current = plan({ nodes: [node('a'), node('b', { needs: ['a'] })] });
    const reloaded = plan({ nodes: [node('a'), node('b')] });
    const decision = mergeReloadedPlan(current, reloaded, new Set());
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') expect(decision.detail).toContain('needs');
  });

  test('a changed source refuses', () => {
    const current = plan({ nodes: [node('a')] });
    const reloaded = plan({ source: 'other.tend.html', nodes: [node('a')] });
    const decision = mergeReloadedPlan(current, reloaded, new Set());
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') expect(decision.detail).toContain('source');
  });

  test('an invalid plan refuses, naming its errors', () => {
    const current = plan({ nodes: [node('a')] });
    // A node whose audit provider equals its worker provider (the default
    // claude) violates the model-diversity rule — validatePlan refuses it.
    const reloaded = plan({
      nodes: [node('a', { accept: { audit: { command: 'audit a', provider: 'claude' } } })],
    });
    const decision = mergeReloadedPlan(current, reloaded, new Set());
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') expect(decision.detail).toContain('diversity');
  });

  test('an identical plan changes nothing', () => {
    const current = plan({ nodes: [node('a')] });
    const reloaded = plan({ nodes: [node('a')] });
    const decision = mergeReloadedPlan(current, reloaded, new Set());
    expect(decision.kind).toBe('applied');
    if (decision.kind !== 'applied') return;
    expect(decision.applied).toEqual([]);
    expect(decision.ignored).toEqual([]);
    expect(decision.plan).toEqual(current);
  });

  test('goal and maxConcurrency take the reloaded values', () => {
    const current = plan({ goal: 'g1', nodes: [node('a')] });
    const reloaded = plan({ goal: 'g2', maxConcurrency: 3, nodes: [node('a')] });
    const decision = mergeReloadedPlan(current, reloaded, new Set());
    expect(decision.kind).toBe('applied');
    if (decision.kind !== 'applied') return;
    expect(decision.plan.goal).toBe('g2');
    expect(decision.plan.maxConcurrency).toBe(3);
  });
});
