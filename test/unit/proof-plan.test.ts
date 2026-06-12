/**
 * Proof-plan contract test.
 *
 * Loads examples/proof/plan.json and asserts:
 *   1. PlanSchema.parse succeeds (schema v1.1.1 conformance).
 *   2. validatePlan returns without throwing.
 *   3. The topological order ends with 'wordcount' (the integration node that
 *      depends on all step nodes).
 *
 * This test keeps the hand-written example permanently honest against schema
 * drift. It lives in test/unit because it is pure in/out — no fs, no git, no
 * processes beyond the import.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { PlanSchema } from '../../src/core/plan.ts';
import { validatePlan } from '../../src/core/validate.ts';

const PLAN_PATH = resolve(import.meta.dir, '../../examples/proof/plan.json');

describe('proof plan — schema conformance', () => {
  test('examples/proof/plan.json parses as a valid Plan (v1.1.1)', async () => {
    const raw = await Bun.file(PLAN_PATH).json();
    const plan = PlanSchema.parse(raw);
    expect(plan.nodes.length).toBeGreaterThan(0);
    expect(plan.goal).toBeTruthy();
    expect(plan.source).toBeTruthy();
  });

  test('validatePlan succeeds and order ends with wordcount (integration node last)', async () => {
    const raw = await Bun.file(PLAN_PATH).json();
    const plan = PlanSchema.parse(raw);
    const { order } = validatePlan(plan);
    expect(order[order.length - 1]).toBe('wordcount');
  });

  test('audit provider is codex (≠ default worker claude)', async () => {
    const raw = await Bun.file(PLAN_PATH).json();
    const plan = PlanSchema.parse(raw);
    const integrationNode = plan.nodes.find((n) => n.id === 'wordcount');
    expect(integrationNode).toBeDefined();
    expect(integrationNode?.accept.audit?.provider).toBe('codex');
    // Worker provider is absent (defaults to 'claude') — model diversity holds.
    expect(integrationNode?.worker.provider).toBeUndefined();
  });
});
