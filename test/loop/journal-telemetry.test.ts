// Cost feed (#18): the journal's verdict event must carry the worker's
// telemetry and the node's wall-clock duration — the casting ledger computes
// cost-per-verified-claim from exactly these fields. Journal-only enrichment:
// the Plan/Verdict contract is untouched (thin waist).
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness, stop } from './harness.ts';

const PLAN = PlanSchema.parse({
  goal: 'g',
  source: 's',
  nodes: [{ id: 'a', work: { prompt: 'build a' } }],
});

describe('journal verdict telemetry (#18 cost feed)', () => {
  test('verdict event carries telemetry and durationMs', async () => {
    const h = makeHarness({
      waitScript: () => Promise.resolve({ ...stop(), telemetry: { tokens: 1234 } }),
    });

    await runPlan(PLAN, h.deps, { repoRoot: '/r' });

    const verdict = h.journal.find((e) => e.event === 'verdict' && e.node === 'a');
    expect(verdict).toBeDefined();
    expect((verdict?.telemetry as Record<string, unknown>).tokens).toBe(1234);
    expect(typeof verdict?.durationMs).toBe('number');
    expect(verdict?.durationMs as number).toBeGreaterThanOrEqual(0);
  });
});

describe('journal verdict attribution (G1 — the casting join)', () => {
  test('verdict events carry the resolved provider and model', async () => {
    const h = makeHarness();
    const plan = PlanSchema.parse({
      goal: 'g',
      source: 's',
      nodes: [
        { id: 'a', work: { prompt: 'build a' } },
        { id: 'b', work: { prompt: 'build b' }, worker: { provider: 'codex', model: 'gpt-5.5' } },
      ],
    });

    await runPlan(plan, h.deps, { repoRoot: '/r' });

    const va = h.journal.find((e) => e.event === 'verdict' && e.node === 'a');
    const vb = h.journal.find((e) => e.event === 'verdict' && e.node === 'b');
    expect(va?.provider).toBe('claude'); // the resolved default — never absent
    expect(vb?.provider).toBe('codex');
    expect(vb?.model).toBe('gpt-5.5');
  });
});
