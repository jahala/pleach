// Node-gate taxonomy (decker wave 2, ledger D10): a transient gate red must
// not become worker evidence — a worker prompted to fix a failure that wasn't
// its fault "fixes" something that isn't broken, and good work ages in
// quarantine. The exec gates (setup, smoke) get ONE gate-only retry in the
// same provisioned worktree — the land gate's flaky-retry doctrine at node
// level. And a red with no output records an explicit marker: the absence of
// evidence is itself diagnostic, never a silent hole.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };

function smokePlan(maxAttempts = 1) {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [
      {
        id: 'x',
        work: { prompt: 'build x' },
        accept: { smoke: 'smokey' },
        policy: { maxAttempts },
      },
    ],
  });
}

describe('the node gate retries once before red is evidence (D10)', () => {
  test('a flaky smoke passes on the gate-only retry — no worker re-prompt, node closes', async () => {
    let smokeCalls = 0;
    const h = makeHarness({
      execScript: (argv) => {
        if (argv[0] === 'smokey') {
          smokeCalls += 1;
          return smokeCalls === 1
            ? { output: 'transient red', exitCode: 1 }
            : { output: '', exitCode: 0 };
        }
        return { output: '', exitCode: 0 };
      },
    });

    const summary = await runPlan(smokePlan(1), h.deps, OPTS);

    expect(summary.closed).toEqual(['x']);
    expect(smokeCalls).toBe(2);
    expect(h.log.count('spawn:build', 'x')).toBe(1); // the worker never saw the flake
    expect(h.journal.some((e) => e.event === 'gate-retry' && e.gate === 'smoke')).toBe(true);
    expect(h.journal.some((e) => e.event === 'gate-flaky' && e.gate === 'smoke')).toBe(true);
  });

  test('a persistent red burns the retry, then fails with the RETRY run as evidence', async () => {
    let smokeCalls = 0;
    const h = makeHarness({
      execScript: (argv) => {
        if (argv[0] === 'smokey') {
          smokeCalls += 1;
          return { output: `red run ${smokeCalls}`, exitCode: 1 };
        }
        return { output: '', exitCode: 0 };
      },
    });

    const summary = await runPlan(smokePlan(1), h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    expect(smokeCalls).toBe(2);
    const verdict = h.journal.find((e) => e.event === 'verdict' && e.node === 'x');
    expect((verdict?.gate as Record<string, unknown>)?.outputTail).toBe('red run 2');
    expect(h.journal.some((e) => e.event === 'gate-flaky')).toBe(false);
  });

  test('a red with no output records the explicit no-output marker, never a silent hole', async () => {
    const h = makeHarness({
      execScript: (argv) =>
        argv[0] === 'smokey' ? { output: '', exitCode: 1 } : { output: '', exitCode: 0 },
    });

    const summary = await runPlan(smokePlan(1), h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    const verdict = h.journal.find((e) => e.event === 'verdict' && e.node === 'x');
    expect(String((verdict?.gate as Record<string, unknown>)?.outputTail)).toContain('no output');
  });

  test('setup gets the same gate-only retry', async () => {
    let setupCalls = 0;
    const h = makeHarness({
      execScript: (argv) => {
        if (argv[0] === 'provision') {
          setupCalls += 1;
          return setupCalls === 1
            ? { output: 'registry hiccup', exitCode: 1 }
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
          setup: 'provision',
          policy: { maxAttempts: 1 },
        },
      ],
    });

    const summary = await runPlan(plan, h.deps, OPTS);

    expect(summary.closed).toEqual(['x']);
    expect(setupCalls).toBe(2);
    expect(h.journal.some((e) => e.event === 'gate-retry' && e.gate === 'setup')).toBe(true);
  });
});
