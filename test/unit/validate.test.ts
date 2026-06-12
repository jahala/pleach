import { describe, expect, test } from 'bun:test';
import { PlanInvalidError } from '../../src/core/errors.ts';
import type { Plan } from '../../src/core/plan.ts';
import { DEFAULT_WORKER_PROVIDER, validatePlan } from '../../src/core/validate.ts';

// Helper: build a minimal valid plan
function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    goal: 'test',
    source: 'test.tend.html',
    nodes: [
      {
        id: 'n1',
        worker: {},
        work: { prompt: 'do it' },
        setup: undefined,
        needs: [],
        accept: {},
        policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
        closes: [],
      },
    ],
    ...overrides,
  };
}

describe('DEFAULT_WORKER_PROVIDER', () => {
  test('is "claude"', () => {
    expect(DEFAULT_WORKER_PROVIDER).toBe('claude');
  });
});

describe('validatePlan — success', () => {
  test('single valid node returns topological order', () => {
    const result = validatePlan(makePlan());
    expect(result.order).toEqual(['n1']);
  });

  test('diamond DAG returns correct topological order', () => {
    // n1 → n2, n1 → n3, n2 + n3 → n4
    const plan: Plan = {
      goal: 'diamond',
      source: 'x.tend.html',
      nodes: [
        {
          id: 'n1',
          worker: {},
          work: { prompt: '' },
          needs: [],
          accept: {},
          policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
          closes: [],
        },
        {
          id: 'n2',
          worker: {},
          work: { prompt: '' },
          needs: ['n1'],
          accept: {},
          policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
          closes: [],
        },
        {
          id: 'n3',
          worker: {},
          work: { prompt: '' },
          needs: ['n1'],
          accept: {},
          policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
          closes: [],
        },
        {
          id: 'n4',
          worker: {},
          work: { prompt: '' },
          needs: ['n2', 'n3'],
          accept: {},
          policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
          closes: [],
        },
      ],
    };
    const { order } = validatePlan(plan);
    // n1 must come first, n4 must come last
    expect(order[0]).toBe('n1');
    expect(order[order.length - 1]).toBe('n4');
    // n2 and n3 must appear before n4
    const n2i = order.indexOf('n2');
    const n3i = order.indexOf('n3');
    const n4i = order.indexOf('n4');
    expect(n2i).toBeLessThan(n4i);
    expect(n3i).toBeLessThan(n4i);
    expect(order).toHaveLength(4);
  });
});

describe('validatePlan — failure modes', () => {
  test('empty nodes array → PlanInvalidError', () => {
    expect(() => validatePlan(makePlan({ nodes: [] }))).toThrow(PlanInvalidError);
    try {
      validatePlan(makePlan({ nodes: [] }));
    } catch (e) {
      expect(e).toBeInstanceOf(PlanInvalidError);
      const err = e as PlanInvalidError;
      expect(err.reasons.some((r) => r.includes('no nodes'))).toBe(true);
    }
  });

  test('duplicate node ids → PlanInvalidError with reason', () => {
    const plan = makePlan({
      nodes: [
        {
          id: 'dup',
          worker: {},
          work: { prompt: '' },
          needs: [],
          accept: {},
          policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
          closes: [],
        },
        {
          id: 'dup',
          worker: {},
          work: { prompt: '' },
          needs: [],
          accept: {},
          policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
          closes: [],
        },
      ],
    });
    expect(() => validatePlan(plan)).toThrow(PlanInvalidError);
    try {
      validatePlan(plan);
    } catch (e) {
      const err = e as PlanInvalidError;
      expect(err.reasons.some((r) => r.includes('dup'))).toBe(true);
    }
  });

  test('unknown needs reference → PlanInvalidError with reason', () => {
    const plan = makePlan({
      nodes: [
        {
          id: 'n1',
          worker: {},
          work: { prompt: '' },
          needs: ['ghost'],
          accept: {},
          policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
          closes: [],
        },
      ],
    });
    expect(() => validatePlan(plan)).toThrow(PlanInvalidError);
    try {
      validatePlan(plan);
    } catch (e) {
      const err = e as PlanInvalidError;
      expect(err.reasons.some((r) => r.includes('ghost'))).toBe(true);
    }
  });

  test('dependency cycle → PlanInvalidError with reason', () => {
    const plan: Plan = {
      goal: 'cycle',
      source: 'x.tend.html',
      nodes: [
        {
          id: 'a',
          worker: {},
          work: { prompt: '' },
          needs: ['b'],
          accept: {},
          policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
          closes: [],
        },
        {
          id: 'b',
          worker: {},
          work: { prompt: '' },
          needs: ['a'],
          accept: {},
          policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
          closes: [],
        },
      ],
    };
    expect(() => validatePlan(plan)).toThrow(PlanInvalidError);
    try {
      validatePlan(plan);
    } catch (e) {
      const err = e as PlanInvalidError;
      expect(err.reasons.some((r) => r.toLowerCase().includes('cycle'))).toBe(true);
    }
  });

  test('audit provider === worker provider → PlanInvalidError (model-diversity rule)', () => {
    const plan = makePlan({
      nodes: [
        {
          id: 'n1',
          worker: { provider: 'claude' },
          work: { prompt: '' },
          needs: [],
          accept: { audit: { command: 'tend audit x', provider: 'claude' } },
          policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
          closes: [],
        },
      ],
    });
    expect(() => validatePlan(plan)).toThrow(PlanInvalidError);
    try {
      validatePlan(plan);
    } catch (e) {
      const err = e as PlanInvalidError;
      expect(
        err.reasons.some(
          (r) => r.toLowerCase().includes('diversity') || r.toLowerCase().includes('provider'),
        ),
      ).toBe(true);
    }
  });

  test('audit provider === DEFAULT_WORKER_PROVIDER when worker.provider is absent → PlanInvalidError', () => {
    // worker.provider is undefined → defaults to 'claude'; audit.provider 'claude' → violation
    const plan = makePlan({
      nodes: [
        {
          id: 'n1',
          worker: {},
          work: { prompt: '' },
          needs: [],
          accept: { audit: { command: 'tend audit x', provider: DEFAULT_WORKER_PROVIDER } },
          policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
          closes: [],
        },
      ],
    });
    expect(() => validatePlan(plan)).toThrow(PlanInvalidError);
  });

  test('combined failures: all reasons reported', () => {
    // dup ids + unknown need + cycle-inducing (dup will prevent cycle detection from running cleanly,
    // but all structurally-independent errors should accumulate)
    const plan: Plan = {
      goal: 'multi-fail',
      source: 'x.tend.html',
      nodes: [
        {
          id: 'dup',
          worker: {},
          work: { prompt: '' },
          needs: ['ghost'],
          accept: {},
          policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
          closes: [],
        },
        {
          id: 'dup',
          worker: {},
          work: { prompt: '' },
          needs: [],
          accept: {},
          policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
          closes: [],
        },
      ],
    };
    try {
      validatePlan(plan);
      // should have thrown
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(PlanInvalidError);
      const err = e as PlanInvalidError;
      // Both dup and unknown-need reasons should be present
      expect(err.reasons.length).toBeGreaterThanOrEqual(2);
      expect(err.reasons.some((r) => r.includes('dup'))).toBe(true);
      expect(err.reasons.some((r) => r.includes('ghost'))).toBe(true);
    }
  });
});
