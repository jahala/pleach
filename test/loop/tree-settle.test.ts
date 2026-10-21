// issue #127 — a worker that ends its turn while its own background command
// still runs is read as finished. The loop must wait for the tree to settle
// after a stop, before any gate reads it. These tests script the in-memory
// tree to change across records and assert the settle waits, then gates the
// settled tree; and that a tree which never settles fails under the `settle`
// gate with the changing path named and the worker re-prompted with it.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, makeHarness } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };

// One {prompt} node whose tree settles after one change.
function promptPlan() {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [
      {
        id: 'x',
        work: { prompt: 'build x' },
        accept: { smoke: 'smokey' },
        policy: { maxAttempts: 2 },
      },
    ],
  });
}

// The single worktree the harness isolated for the node.
function cwdOf(h: Harness): string {
  const keys = [...h.git.worktree.keys()];
  if (keys.length !== 1) throw new Error(`expected one worktree, got ${keys.length}`);
  return keys[0] as string;
}

describe('the tree settles before a gate reads it (issue #127)', () => {
  test('a tree that changes once then settles waits two windows, then the smoke gate runs and closes', async () => {
    let sleeps = 0;
    const h = makeHarness({ changedByNode: { x: ['work.out'] } });
    const realSleep = h.deps.sleep;
    h.deps.sleep = async (ms: number) => {
      await realSleep(ms);
      sleeps += 1;
      if (sleeps === 1) {
        const wt = new Map(h.git.worktree.get(cwdOf(h)) ?? []);
        wt.set('late.txt', 'late\n');
        h.git.worktree.set(cwdOf(h), wt);
      }
    };

    const summary = await runPlan(promptPlan(), h.deps, OPTS);

    expect(summary.closed).toEqual(['x']);
    // Two settle windows of 2000ms, exactly as the design demands.
    expect(h.log.of('sleep').map((e) => Number(e.detail))).toEqual([2000, 2000]);
    // The settle sleeps happen before the smoke gate exec.
    const smokeAt = h.log.events.find((e) => e.kind === 'exec' && e.detail === 'smokey')?.at;
    expect(smokeAt).toBeDefined();
    expect(h.log.last('sleep')).toBeLessThan(smokeAt as number);
  });

  test('a tree that never settles fails under the settle gate, naming the changing path and re-prompting the worker', async () => {
    let n = 0;
    const h = makeHarness({ changedByNode: { x: ['work.out'] } });
    const realSleep = h.deps.sleep;
    h.deps.sleep = async (ms: number) => {
      await realSleep(ms);
      n += 1;
      const wt = new Map(h.git.worktree.get(cwdOf(h)) ?? []);
      wt.set('late.txt', `late-${n}\n`);
      h.git.worktree.set(cwdOf(h), wt);
    };

    const summary = await runPlan(promptPlan(), h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    const verdict = h.emitted.find((v) => v.node === 'x');
    expect(verdict?.status).toBe('failed');
    expect(verdict?.evidence.gate).toEqual({ ran: 'settle', exitCode: -1 });

    // The worker is re-prompted (attempt 2) with the changing path in the evidence.
    const sends = h.log.of('send').filter((e) => e.node === 'x');
    expect(sends.length).toBe(2);
    expect(sends[1]?.detail).toContain('late.txt');

    // The failure was journaled with the changing path.
    const still = h.journal.find((e) => e.event === 'tree-still-changing');
    expect(still?.node).toBe('x');
    expect(still?.paths).toContain('late.txt');
  });
});
