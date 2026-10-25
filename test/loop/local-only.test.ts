// Loop: the run-end and landed journal lines name what is local-only (issue #130).
//
// The pure computation lives in core/local-only.ts; these tests prove the loop
// calls the seam, computes the report, and appends it under `localOnly` on the
// two lines the design names. In-memory seams per the testing doctrine.
import { describe, expect, test } from 'bun:test';
import type { Plan } from '../../src/core/plan.ts';
import { landPlan } from '../../src/loop/land.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness, makeNode } from './harness.ts';

const REPO = '/repo';

function plan(nodes: Plan['nodes']): Plan {
  return { goal: 'g', source: 's', nodes };
}

describe('run-end names what is local-only (issue #130)', () => {
  test('run-end carries the report computed from the seam facts', async () => {
    const h = makeHarness({
      localOnlyFacts: {
        nodeBranches: [
          { name: 'node/a', sha: 'sha-a' },
          { name: 'node/b', sha: 'sha-b' },
        ],
        notOnRemote: new Set(['sha-a']),
        remotes: 1,
      },
    });
    await runPlan(plan([makeNode({ id: 'a' })]), h.deps, { repoRoot: REPO });

    const end = h.journal.find((e) => e.event === 'run-end');
    expect(end?.localOnly).toEqual({ nodeBranches: ['node/a'], remotes: 1 });
  });
});

describe('landed names how far ahead of its upstream (issue #130)', () => {
  test('landed carries the count when the branch has an upstream', async () => {
    const h = makeHarness({
      closed: new Map([['a', 'sha-a']]),
      refs: { 'node/a': 'sha-a' },
      branchUpstream: { upstream: 'origin/main', ahead: 3 },
    });
    await landPlan(plan([makeNode({ id: 'a' })]), h.deps, { repoRoot: REPO });

    const landed = h.journal.find((e) => e.event === 'landed');
    expect(landed?.localOnly).toEqual({ aheadOfUpstream: 3 });
  });

  test('landed carries null when the branch has no upstream', async () => {
    const h = makeHarness({
      closed: new Map([['a', 'sha-a']]),
      refs: { 'node/a': 'sha-a' },
      branchUpstream: { upstream: null, ahead: 0 },
    });
    await landPlan(plan([makeNode({ id: 'a' })]), h.deps, { repoRoot: REPO });

    const landed = h.journal.find((e) => e.event === 'landed');
    expect(landed?.localOnly).toEqual({ aheadOfUpstream: null });
  });
});

describe('a failed local-only read never costs the record (issue #130)', () => {
  test('run-end is still written, followed by local-only-check-failed', async () => {
    const h = makeHarness({ localOnlyThrows: new Error('git exploded (test)') });
    const summary = await runPlan(plan([makeNode({ id: 'a' })]), h.deps, { repoRoot: REPO });

    expect(summary.closed).toEqual(['a']);
    const events = h.journal.map((e) => e.event);
    const end = events.indexOf('run-end');
    expect(end).toBeGreaterThan(-1);
    expect(h.journal[end]?.localOnly).toBeUndefined();
    const failed = h.journal.find((e) => e.event === 'local-only-check-failed');
    expect(String(failed?.detail)).toContain('git exploded (test)');
  });

  test('landed is still written after the publish, followed by local-only-check-failed', async () => {
    const h = makeHarness({
      closed: new Map([['a', 'sha-a']]),
      refs: { 'node/a': 'sha-a' },
      localOnlyThrows: new Error('git exploded (test)'),
    });
    const result = await landPlan(plan([makeNode({ id: 'a' })]), h.deps, { repoRoot: REPO });

    expect(result.landed).toEqual(['a']);
    const landed = h.journal.find((e) => e.event === 'landed');
    expect(landed).toBeDefined();
    expect(landed?.localOnly).toBeUndefined();
    const failed = h.journal.find((e) => e.event === 'local-only-check-failed');
    expect(String(failed?.detail)).toContain('git exploded (test)');
  });
});
