// D12's other half: Ctrl-C / SIGTERM must tear a run down, not orphan it.
// The signal is a PARAMETER (RunPlanOpts.signal) — the face owns process
// signals; the loop honors the abort: in-flight waits end promptly, workers
// are killed, trees disposed, nothing new launches, and the journal says why.
// Work-phase commands and gates deliberately run to completion (bounded by
// their own timeouts) — only the wait is the long pole worth interrupting.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness } from './harness.ts';

describe('an aborted run tears down instead of orphaning (D12)', () => {
  test('abort ends the in-flight wait, skips the queue, journals run-aborted', async () => {
    const controller = new AbortController();
    const h = makeHarness({
      // A wait that never resolves on its own — only the abort ends it.
      waitScript: () => new Promise(() => {}),
    });
    const plan = PlanSchema.parse({
      goal: 'g',
      source: 's',
      nodes: [
        { id: 'a', work: { prompt: 'build a' }, policy: { maxAttempts: 1 } },
        { id: 'b', work: { prompt: 'build b' }, policy: { maxAttempts: 1 } },
      ],
    });

    setTimeout(() => controller.abort(), 20);
    const summary = await runPlan(plan, h.deps, {
      repoRoot: '/r',
      maxConcurrency: 1,
      signal: controller.signal,
    });

    expect(summary.failed).toEqual(['a']); // the in-flight node settles failed
    expect(summary.skipped).toEqual(['b']); // never launched
    expect(h.log.count('spawn:build')).toBe(1);
    expect(h.log.count('kill', 'a')).toBe(1); // the worker did not outlive the run
    expect(h.log.count('dispose', 'a')).toBe(1); // the tree did not either
    expect(h.journal.some((e) => e.event === 'run-aborted')).toBe(true);
  });

  test('a run that finishes before any abort journals nothing extra', async () => {
    const controller = new AbortController();
    const h = makeHarness();
    const plan = PlanSchema.parse({
      goal: 'g',
      source: 's',
      nodes: [{ id: 'a', work: { prompt: 'build a' }, policy: { maxAttempts: 1 } }],
    });

    const summary = await runPlan(plan, h.deps, { repoRoot: '/r', signal: controller.signal });

    expect(summary.closed).toEqual(['a']);
    expect(h.journal.some((e) => e.event === 'run-aborted')).toBe(false);
  });
});
