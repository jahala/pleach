// issue #63 — the journal says what a running node is doing.
//
// Between node-start and verdict nothing told a watcher which attempt, phase or
// gate was in flight. The loop now journals `attempt-start`, `phase-start`,
// `gate-start`/`gate-end` and `audit-check` as they happen. These tests pin the
// ORDER of those lines (the whole point — a watcher reads the journal top to
// bottom) and the fields a reader needs: the failing gate's exitCode and output
// tail, the phase index, and one audit-check per parsed egress verdict.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };

// The journal events a watcher reads, in file order, with the fields the fold
// and the narrator consume. Only the events this issue added, in order.
function gateTrace(journal: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return journal.filter((e) => {
    const name = e.event;
    return (
      name === 'attempt-start' ||
      name === 'phase-start' ||
      name === 'gate-start' ||
      name === 'gate-end' ||
      name === 'audit-check' ||
      name === 'verdict'
    );
  });
}

describe('the run journal carries gate events as they happen (issue #63)', () => {
  test('a smoke red on attempt 1 and green on attempt 2 journals the gate pairs in order', async () => {
    let smokeCalls = 0;
    const h = makeHarness({
      execScript: (argv) => {
        if (argv[0] === 'smokey') {
          smokeCalls += 1;
          return smokeCalls <= 2
            ? { output: 'smoke refused: missing built.txt', exitCode: 1 }
            : { output: '', exitCode: 0 };
        }
        return { output: '', exitCode: 0 };
      },
    });
    const plan = PlanSchema.parse({
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

    const summary = await runPlan(plan, h.deps, OPTS);
    expect(summary.closed).toEqual(['x']);

    const trace = gateTrace(h.journal);
    const names = trace.map((e) => e.event);
    expect(names[0]).toBe('attempt-start');
    expect(names[names.length - 1]).toBe('verdict');

    // attempt 1 starts, its smoke gate goes red with the output tail, then
    // attempt 2 starts, its smoke passes, then the verdict.
    const attempt1 = trace.findIndex((e) => e.event === 'attempt-start' && e.attempt === 1);
    const attempt2 = trace.findIndex((e) => e.event === 'attempt-start' && e.attempt === 2);
    const smokeStart1 = trace.findIndex((e) => e.event === 'gate-start' && e.gate === 'smoke');
    const smokeEnd1 = trace.findIndex(
      (e) => e.event === 'gate-end' && e.gate === 'smoke' && (e.exitCode as number) !== 0,
    );
    const smokeEnd2 = trace.findIndex(
      (e) => e.event === 'gate-end' && e.gate === 'smoke' && (e.exitCode as number) === 0,
    );
    const verdict = trace.findIndex((e) => e.event === 'verdict');

    expect(attempt1).toBe(0);
    expect(smokeStart1).toBeGreaterThan(attempt1);
    expect(smokeEnd1).toBeGreaterThan(smokeStart1);
    expect(attempt2).toBeGreaterThan(smokeEnd1);
    expect(smokeEnd2).toBeGreaterThan(attempt2);
    expect(verdict).toBeGreaterThan(smokeEnd2);

    // The failing gate-end carries the attempt, the exit code and the tail.
    const failing = trace[smokeEnd1] as Record<string, unknown>;
    expect(failing.attempt).toBe(1);
    expect(failing.exitCode).toBe(1);
    expect(String(failing.outputTail)).toContain('missing built.txt');
    expect(failing.durationMs).toBeTypeOf('number');

    // The passing gate-end carries no output tail.
    const passing = trace[smokeEnd2] as Record<string, unknown>;
    expect(passing.attempt).toBe(2);
    expect(passing.exitCode).toBe(0);
    expect(Object.hasOwn(passing, 'outputTail')).toBe(false);

    // attempt-start names the resolved provider.
    expect((trace[attempt1] as Record<string, unknown>).provider).toBe('claude');
  });

  test('a phased node journals a phase-start per phase and the red and green gates in order', async () => {
    let testCalls = 0;
    const h = makeHarness({
      execScript: (argv) => {
        if (argv[0] === 'runtests') {
          testCalls += 1;
          return testCalls === 1
            ? { output: 'FAIL widget: not implemented', exitCode: 1 }
            : { output: 'ok 1 widget', exitCode: 0 };
        }
        return { output: '', exitCode: 0 };
      },
    });
    const plan = PlanSchema.parse({
      goal: 'g',
      source: 's',
      nodes: [
        {
          id: 'p',
          work: {
            test: 'runtests',
            phases: [
              { phase: 'red', prompt: 'write the failing test' },
              { phase: 'impl', prompt: 'make it pass' },
              { phase: 'green', prompt: 'run the suite' },
            ],
          },
          policy: { maxAttempts: 1 },
        },
      ],
    });

    const summary = await runPlan(plan, h.deps, OPTS);
    expect(summary.closed).toEqual(['p']);

    const phases = h.journal
      .filter((e) => e.event === 'phase-start')
      .map((e) => ({ phase: e.phase, index: e.index, attempt: e.attempt }));
    expect(phases).toEqual([
      { phase: 'red', index: 0, attempt: 1 },
      { phase: 'impl', index: 1, attempt: 1 },
      { phase: 'green', index: 2, attempt: 1 },
    ]);

    const trace = gateTrace(h.journal);
    const redStart = trace.findIndex((e) => e.event === 'gate-start' && e.gate === 'red');
    const redEnd = trace.findIndex((e) => e.event === 'gate-end' && e.gate === 'red');
    const greenStart = trace.findIndex((e) => e.event === 'gate-start' && e.gate === 'green');
    const greenEnd = trace.findIndex((e) => e.event === 'gate-end' && e.gate === 'green');
    expect(redStart).toBeGreaterThanOrEqual(0);
    expect(redEnd).toBeGreaterThan(redStart);
    expect(greenStart).toBeGreaterThan(redEnd);
    expect(greenEnd).toBeGreaterThan(greenStart);

    // RED passed means the test failed (gate exit 0); GREEN passed means the
    // test passed (gate exit 0).
    expect((trace[redEnd] as Record<string, unknown>).exitCode).toBe(0);
    expect((trace[greenEnd] as Record<string, unknown>).exitCode).toBe(0);
  });

  test('an audited node journals one audit-check per egress verdict', async () => {
    const h = makeHarness({
      auditEgress: () =>
        '```tend-audit-result\n' +
        '{"verdicts":[{"check":"c1","verdict":"pass"},{"check":"c2","verdict":"pass"}]}\n' +
        '```',
    });
    const plan = PlanSchema.parse({
      goal: 'g',
      source: 's',
      nodes: [
        {
          id: 'a',
          work: { prompt: 'build a' },
          accept: { audit: { command: 'tend audit a', provider: 'codex' } },
          policy: { maxAttempts: 1 },
        },
      ],
    });

    const summary = await runPlan(plan, h.deps, OPTS);
    expect(summary.closed).toEqual(['a']);

    const checks = h.journal
      .filter((e) => e.event === 'audit-check')
      .map((e) => ({ check: e.check, verdict: e.verdict, attempt: e.attempt }));
    expect(checks).toEqual([
      { check: 'c1', verdict: 'pass', attempt: 1 },
      { check: 'c2', verdict: 'pass', attempt: 1 },
    ]);
  });
});
