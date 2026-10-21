import { describe, expect, test } from 'bun:test';
import { PlanInvalidError } from '../../src/core/errors.ts';
import type { Plan } from '../../src/core/plan.ts';
import { validatePlan } from '../../src/core/validate.ts';

// Subject: validatePlan's optional provider gate (issue #146). The face passes
// the runner's provider list plus the config's cast names; a node or audit
// naming neither is refused with the known names listed. No list → nothing
// refused (the scripted runner accepts any provider).

const KNOWN = ['claude', 'codex', 'deepseek'];

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

function node(over: Record<string, unknown> = {}): Plan['nodes'][number] {
  return {
    id: 'n1',
    worker: {},
    work: { prompt: 'do it' },
    needs: [],
    accept: {},
    policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
    closes: [],
    ...over,
  } as Plan['nodes'][number];
}

describe('validatePlan — provider gate (issue #146)', () => {
  test('refuses an unknown worker provider, naming the known ones', () => {
    const plan = makePlan({ nodes: [node({ worker: { provider: 'cluade' } })] });
    expect(() => validatePlan(plan, KNOWN)).toThrow(PlanInvalidError);
    try {
      validatePlan(plan, KNOWN);
    } catch (e) {
      const err = e as PlanInvalidError;
      expect(err.reasons.some((r) => r.includes('cluade'))).toBe(true);
      const reason = err.reasons.find((r) => r.includes('cluade')) ?? '';
      expect(reason).toContain('claude');
      expect(reason).toContain('codex');
      expect(reason).toContain('deepseek');
    }
  });

  test('refuses an unknown audit provider, naming the known ones', () => {
    const plan = makePlan({
      nodes: [
        node({
          worker: { provider: 'claude' },
          accept: { audit: { command: 'tend audit x', provider: 'cluade' } },
        }),
      ],
    });
    expect(() => validatePlan(plan, KNOWN)).toThrow(PlanInvalidError);
    try {
      validatePlan(plan, KNOWN);
    } catch (e) {
      const err = e as PlanInvalidError;
      expect(err.reasons.some((r) => r.includes('cluade'))).toBe(true);
    }
  });

  test('accepts a declared cast name as a worker provider', () => {
    const plan = makePlan({ nodes: [node({ worker: { provider: 'deepseek' } })] });
    expect(() => validatePlan(plan, KNOWN)).not.toThrow();
  });

  test('accepts a declared cast name as an audit provider', () => {
    const plan = makePlan({
      nodes: [
        node({
          worker: { provider: 'claude' },
          accept: { audit: { command: 'tend audit x', provider: 'deepseek' } },
        }),
      ],
    });
    expect(() => validatePlan(plan, KNOWN)).not.toThrow();
  });

  test('accepts anything when no provider list is given (scripted runner)', () => {
    const plan = makePlan({ nodes: [node({ worker: { provider: 'cluade' } })] });
    expect(() => validatePlan(plan)).not.toThrow();
  });

  test('two casts are two providers: diversity rule compares the plan names', () => {
    const plan = makePlan({
      nodes: [
        node({
          worker: { provider: 'opus' },
          accept: { audit: { command: 'tend audit x', provider: 'deepseek' } },
        }),
      ],
    });
    expect(() => validatePlan(plan, ['claude', 'opus', 'deepseek'])).not.toThrow();
  });
});
