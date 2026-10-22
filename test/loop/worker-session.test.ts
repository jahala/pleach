import { describe, expect, test } from 'bun:test';
import type { Plan } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness, makeNode } from './harness.ts';

// issue #115 — the loop names every session it spawns and kills, so `pleach
// clean` can reap what a crash left alive. A worker whose runner gives it a
// `session` journals `worker-spawned` right after the spawn and
// `worker-killed` right after the kill; a runner without one journals neither.

const REPO = '/repo';
const SRC = 'garden.tend.html';

describe('worker session journaling (#115)', () => {
  test('a worker with a session journals worker-spawned then worker-killed', async () => {
    const h = makeHarness({
      workerSession: (ctx) => `pl-${ctx.node}-${ctx.role}-${ctx.spawnIndex}`,
    });
    const plan: Plan = {
      goal: 'g',
      source: SRC,
      nodes: [makeNode({ id: 'a' })],
    };
    const summary = await runPlan(plan, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    expect(summary.closed).toEqual(['a']);

    const spawned = h.journal.filter((e) => e.event === 'worker-spawned');
    const killed = h.journal.filter((e) => e.event === 'worker-killed');
    expect(spawned).toEqual([{ event: 'worker-spawned', node: 'a', session: 'pl-a-build-0' }]);
    expect(killed).toEqual([{ event: 'worker-killed', node: 'a', session: 'pl-a-build-0' }]);
  });

  test('a worker without a session journals neither event', async () => {
    const h = makeHarness();
    const plan: Plan = {
      goal: 'g',
      source: SRC,
      nodes: [makeNode({ id: 'a' })],
    };
    await runPlan(plan, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    expect(h.journal.filter((e) => e.event === 'worker-spawned')).toEqual([]);
    expect(h.journal.filter((e) => e.event === 'worker-killed')).toEqual([]);
  });

  test('an audited node journals the auditor session too', async () => {
    const h = makeHarness({
      workerSession: (ctx) => `pl-${ctx.node}-${ctx.role}-${ctx.spawnIndex}`,
    });
    const plan: Plan = {
      goal: 'g',
      source: SRC,
      nodes: [
        makeNode({
          id: 'a',
          accept: { audit: { command: 'audit a', provider: 'codex' } },
        }),
      ],
    };
    const summary = await runPlan(plan, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    expect(summary.closed).toEqual(['a']);

    const spawned = h.journal.filter((e) => e.event === 'worker-spawned');
    expect(spawned).toEqual([
      { event: 'worker-spawned', node: 'a', session: 'pl-a-build-0' },
      { event: 'worker-spawned', node: 'a', session: 'pl-a-audit-0' },
    ]);
    const killed = h.journal.filter((e) => e.event === 'worker-killed');
    expect(killed).toEqual([
      { event: 'worker-killed', node: 'a', session: 'pl-a-build-0' },
      { event: 'worker-killed', node: 'a', session: 'pl-a-audit-0' },
    ]);
  });
});
