// The contract promises: when a plan omits maxConcurrency, the CONDUCTOR
// defaults to cores−2 (plan-schema.md, Plan.maxConcurrency). The loop stays
// os-free: the face computes that number and passes it as
// opts.defaultConcurrency; the loop applies the precedence
// flag > plan.maxConcurrency > defaultConcurrency > 1.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness, stop } from './harness.ts';

function plan(maxConcurrency?: number) {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    nodes: [
      { id: 'a', work: { prompt: 'build a' } },
      { id: 'b', work: { prompt: 'build b' } },
      { id: 'c', work: { prompt: 'build c' } },
    ],
  });
}

// Deterministic concurrency probe: workers park until the test releases them,
// so the number of spawned builders IS the scheduler's launch width.
function gatedHarness() {
  const release: Array<() => void> = [];
  const h = makeHarness({
    waitScript: () =>
      new Promise((res) => {
        release.push(() => res(stop()));
      }),
  });
  return { h, release };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never became true');
}

async function drain(release: Array<() => void>, done: Promise<unknown>): Promise<void> {
  // Keep releasing parked workers until the run settles.
  const settled = { flag: false };
  const tail = done.then(() => {
    settled.flag = true;
  });
  while (!settled.flag) {
    while (release.length > 0) release.shift()?.();
    await new Promise((r) => setTimeout(r, 5));
  }
  await tail;
}

describe('concurrency default (contract: conductor defaults to cores−2 via the face)', () => {
  test('defaultConcurrency opens the launch width when the plan is silent', async () => {
    const { h, release } = gatedHarness();
    const run = runPlan(plan(), h.deps, { repoRoot: '/r', defaultConcurrency: 3 });

    await until(() => h.log.count('spawn:build') === 3);
    expect(h.log.count('spawn:build')).toBe(3);

    await drain(release, run);
    const summary = await run;
    expect(summary.closed.sort()).toEqual(['a', 'b', 'c']);
  });

  test('with no default and no plan cap, the launch width is 1 (conservative floor)', async () => {
    const { h, release } = gatedHarness();
    const run = runPlan(plan(), h.deps, { repoRoot: '/r' });

    await until(() => h.log.count('spawn:build') === 1);
    // Give the scheduler a beat — a second spawn would be a regression.
    await new Promise((r) => setTimeout(r, 25));
    expect(h.log.count('spawn:build')).toBe(1);

    await drain(release, run);
    await run;
  });

  test('plan.maxConcurrency beats defaultConcurrency', async () => {
    const { h, release } = gatedHarness();
    const run = runPlan(plan(2), h.deps, { repoRoot: '/r', defaultConcurrency: 3 });

    await until(() => h.log.count('spawn:build') === 2);
    await new Promise((r) => setTimeout(r, 25));
    expect(h.log.count('spawn:build')).toBe(2);

    await drain(release, run);
    await run;
  });

  test('the explicit flag beats both plan and default', async () => {
    const { h, release } = gatedHarness();
    const run = runPlan(plan(2), h.deps, {
      repoRoot: '/r',
      maxConcurrency: 1,
      defaultConcurrency: 3,
    });

    await until(() => h.log.count('spawn:build') === 1);
    await new Promise((r) => setTimeout(r, 25));
    expect(h.log.count('spawn:build')).toBe(1);

    await drain(release, run);
    await run;
  });
});
