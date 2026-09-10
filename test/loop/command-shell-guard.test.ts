// Canary catch, ladder level: a {command} node whose string contains bare
// shell operators must fail LOUD naming the escape hatch — never silently
// exec garbage. Since D19 the plan is refused before the run starts; the exec
// guard stays for any caller that reaches runWork without validatePlan. And
// the failing gate's output tail must reach the journal (the canary debug
// required a wrapper script to see verify's output — that gap cost a human
// debugging detour on day one of real usage).
import { describe, expect, test } from 'bun:test';
import { GateCannotRunError, PlanInvalidError } from '../../src/core/errors.ts';
import { type Node, PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { runWork } from '../../src/loop/run-work.ts';
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
    const err = await runPlan(commandPlan('mkdir -p tools && echo x > tools/w.mjs'), h.deps, {
      repoRoot: '/r',
    }).then(
      () => null,
      (e: unknown) => e,
    );

    // ledger: D19 — the plan is refused before anything runs.
    expect(err).toBeInstanceOf(PlanInvalidError);
    const reasons = (err as PlanInvalidError).reasons.join('\n');
    expect(reasons).toContain('&&');
    expect(reasons).toContain('bash -lc');
    // The command never ran — no exec of mkdir happened.
    expect(h.log.of('exec').some((e) => e.detail?.startsWith('mkdir'))).toBe(false);
  });

  test('the exec guard still refuses at exec when runWork is reached directly', async () => {
    const h = makeHarness();
    const node = commandPlan('mkdir -p tools && echo x > tools/w.mjs').nodes[0] as Node;

    const err = await runWork(node, null, h.deps.exec, '/wt', { timeoutMs: 1000 }).then(
      () => null,
      (e: unknown) => e,
    );

    // A refusal is no red the work can fix: the plan's fault, not a retry (D19).
    expect(err).toBeInstanceOf(GateCannotRunError);
    expect((err as GateCannotRunError).fault).toBe('plan');
    expect((err as GateCannotRunError).exitCode).toBe(-1);
    expect((err as GateCannotRunError).output).toContain('&&');
    expect((err as GateCannotRunError).output).toContain('bash -lc');
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
