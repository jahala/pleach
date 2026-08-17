// Canary catch, ladder level: a {command} node whose string contains bare
// shell operators must fail LOUD naming the escape hatch — never silently
// exec garbage. And the failing gate's output tail must reach the journal
// (the canary debug required a wrapper script to see verify's output — that
// gap cost a human debugging detour on day one of real usage).
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness } from './harness.ts';

function commandPlan(command: string) {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [{ id: 'c', work: { command }, policy: { maxAttempts: 1 } }],
  });
}

describe('command shell guard + gate output in journal', () => {
  test('bare shell operators fail loud with the bash -lc escape hatch named', async () => {
    const h = makeHarness();
    const summary = await runPlan(commandPlan('mkdir -p tools && echo x > tools/w.mjs'), h.deps, {
      repoRoot: '/r',
    });

    expect(summary.failed).toEqual(['c']);
    const verdict = h.journal.find((e) => e.event === 'verdict' && e.node === 'c');
    const gate = verdict?.gate as Record<string, unknown>;
    expect(String(gate.outputTail)).toContain('&&');
    expect(String(gate.outputTail)).toContain('bash -lc');
    // The command never ran — no exec of mkdir happened.
    expect(h.log.of('exec').some((e) => e.detail?.startsWith('mkdir'))).toBe(false);
  });

  test('a failing command gate journals its output tail', async () => {
    const h = makeHarness({
      execScript: (argv) =>
        argv[0] === 'failing-tool'
          ? { output: 'stack trace: the actual reason it broke', exitCode: 1 }
          : { output: '', exitCode: 0 },
    });
    const summary = await runPlan(commandPlan('failing-tool run'), h.deps, { repoRoot: '/r' });

    expect(summary.failed).toEqual(['c']);
    const verdict = h.journal.find((e) => e.event === 'verdict' && e.node === 'c');
    const gate = verdict?.gate as Record<string, unknown>;
    expect(String(gate.outputTail)).toContain('the actual reason it broke');
  });
});
