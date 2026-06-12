import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { AuditResultSchema, NodeSchema, PlanSchema, VerdictSchema } from '../../src/core/plan.ts';

// ---------------------------------------------------------------------------
// Drift guard: src/core/plan.ts must byte-match the fenced block in the contract doc
// ---------------------------------------------------------------------------
const CONTRACT_PATH = new URL('../../docs/contract/plan-schema.md', import.meta.url).pathname;
const PLAN_PATH = new URL('../../src/core/plan.ts', import.meta.url).pathname;

function extractFencedTs(md: string): string {
  const match = md.match(/```ts\n([\s\S]*?)```/);
  if (!match) throw new Error('No ```ts fenced block found in contract doc');
  // Normalize line endings only
  return match[1].replace(/\r\n/g, '\n');
}

describe('drift guard', () => {
  test('src/core/plan.ts matches the fenced block in docs/contract/plan-schema.md', () => {
    const contractMd = readFileSync(CONTRACT_PATH, 'utf8');
    const fencedBlock = extractFencedTs(contractMd);

    const planSrc = readFileSync(PLAN_PATH, 'utf8').replace(/\r\n/g, '\n');

    expect(planSrc).toBe(fencedBlock);
  });
});

// ---------------------------------------------------------------------------
// Behavioral tests
// ---------------------------------------------------------------------------
describe('Node schema', () => {
  test('omitted policy parses with all defaults (prefault semantics)', () => {
    const node = NodeSchema.parse({
      id: 'my-node',
      work: { prompt: 'do stuff' },
    });
    expect(node.policy.maxAttempts).toBe(2);
    expect(node.policy.onDead).toBe('resume');
    expect(node.policy.reauditWhen).toEqual(['compacted']);
  });

  test('node id "bad id!" is rejected (charset)', () => {
    expect(() =>
      NodeSchema.parse({
        id: 'bad id!',
        work: { prompt: 'x' },
      }),
    ).toThrow();
  });

  test('node id with valid chars is accepted', () => {
    const node = NodeSchema.parse({
      id: 'A1.step:two-ok_v3',
      work: { prompt: 'x' },
    });
    expect(node.id).toBe('A1.step:two-ok_v3');
  });
});

describe('Verdict schema', () => {
  test('status "blocked" is accepted', () => {
    const v = VerdictSchema.parse({
      node: 'my-node',
      status: 'blocked',
      output: null,
      evidence: {},
      attempts: 1,
    });
    expect(v.status).toBe('blocked');
  });
});

describe('AuditResult schema', () => {
  test('extra agent-authored "result" field is stripped (zod objects are non-strict by default)', () => {
    // The schema has a comment: // NO agent-authored `result` — the ingester derives it
    // But zod objects default to strip (not strict), so an extra `result` field is silently dropped.
    // This test asserts the TRUE behavior — not invented strictness.
    const raw = {
      verdicts: [],
      drift: [],
      result: 'SHOULD_BE_STRIPPED',
    };
    const parsed = AuditResultSchema.parse(raw);
    expect((parsed as Record<string, unknown>).result).toBeUndefined();
  });

  test('valid AuditResult with verdicts parses correctly', () => {
    const ar = AuditResultSchema.parse({
      verdicts: [
        {
          check: 'check-1',
          verdict: 'pass',
        },
        {
          check: 'check-2',
          verdict: 'partial',
          reasons: ['not quite'],
        },
      ],
    });
    expect(ar.verdicts).toHaveLength(2);
    expect(ar.verdicts[0].verdict).toBe('pass');
    expect(ar.verdicts[1].verdict).toBe('partial');
    expect(ar.drift).toEqual([]);
  });
});

describe('Plan schema', () => {
  test('minimal valid plan parses', () => {
    const plan = PlanSchema.parse({
      goal: 'bootstrap',
      source: 'feature-1.tend.html',
      nodes: [{ id: 'n1', work: { prompt: 'do it' } }],
    });
    expect(plan.nodes).toHaveLength(1);
    expect(plan.nodes[0].needs).toEqual([]);
  });
});
