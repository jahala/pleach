// ledger: D13 — an empty red phase is a harness error, not a red.
//
// The seal (test/loop/phase-commit.test.ts) turns the RED state into history.
// It can only do that when the red phase actually wrote something: a test
// command that exits non-zero over a tree the phase never touched is a broken
// harness (missing runner, wrong path, ENOENT), and sealing it would mint a
// commit claiming a failing test exists when none does — the exact lie D13
// exists to prevent. So when the red phase's file set (what the worker reported
// touching ∪ what the tree shows changed) is EMPTY, the `red` gate fails with
// evidence naming the empty phase, nothing is staged, nothing is committed, and
// the failure is retryable like any other gate: same tree, re-prompt carrying
// the evidence, restart at the red phase.
//
// In-memory seams (harness.ts); the subject is the loop's phase ladder.
import { describe, expect, test } from 'bun:test';
import type { Plan } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness, makeNode, stop } from './harness.ts';

const OPTS = { repoRoot: '/repo', defaultTimeoutMs: 1000 };

function plan(nodes: Plan['nodes']): Plan {
  return { goal: 'g', source: 'garden.tend.html', nodes };
}

function phasedNode(id: string, maxAttempts: number) {
  return makeNode({
    id,
    work: {
      test: 'runtests',
      phases: [
        { phase: 'red', prompt: 'write the failing test' },
        { phase: 'impl', prompt: 'make it pass' },
        { phase: 'green', prompt: 'run the suite' },
      ],
    },
    policy: { maxAttempts, onDead: 'resume', reauditWhen: ['compacted'] },
  });
}

// The evidence must NAME what went wrong, or the retry is blind: the phase that
// produced nothing, and that no file changed. Two independent regexes, because
// wording is the author's — the content requirement is not.
function namesTheEmptyRedPhase(text: string): boolean {
  return /\bred\b/i.test(text) && /no files?|nothing|empty/i.test(text);
}

describe('phase commit (D13) — an empty red phase never seals', () => {
  test('red gate fails with evidence, no seal, retried in the same tree', async () => {
    const h = makeHarness({
      // Nothing in the tree and nothing reported touched: the worker ran the
      // test command (which fails, as a red must) but wrote no test.
      changedByNode: { n1: [] },
      waitScript: () => stop({ filesTouched: [] }),
      execScript: (argv) =>
        argv[0] === 'runtests'
          ? { output: 'error: no test files found', exitCode: 1 }
          : { output: '', exitCode: 0 },
    });
    const summary = await runPlan(plan([phasedNode('n1', 2)]), h.deps, OPTS);

    expect(summary.closed).toEqual([]);
    expect(summary.failed).toEqual(['n1']);

    // ── nothing was staged, nothing committed, nothing published or sealed.
    expect(h.journal.some((e) => e.event === 'phase-commit')).toBe(false);
    expect(h.log.count('commit')).toBe(0);
    expect(h.log.count('commitBranch')).toBe(0);
    expect(h.log.count('stage')).toBe(0);
    expect(h.git.refs.size).toBe(0);

    // ── the impl phase never got its prompt: the ladder stopped at red.
    expect(h.log.events.some((e) => e.kind === 'send' && e.detail === 'build:make it pass')).toBe(
      false,
    );

    // ── the red gate's own exit-code condition was met on every attempt: the
    // test command ran and failed. The rejection is the empty phase, nothing
    // upstream of it — and since the ladder stops there, the command runs once
    // per attempt, never again for a green gate.
    expect(h.log.of('exec').filter((e) => e.detail === 'runtests').length).toBe(2);

    // ── retryable like any gate: one tree, re-prompted, restarting at red with
    // the evidence attached to the first phase prompt (A3).
    expect(h.log.count('isolate', 'n1')).toBe(1);
    expect(h.log.count('spawn:build', 'n1')).toBe(2);
    const sends = h.log.events
      .filter((e) => e.kind === 'send' && e.node === 'n1')
      .map((e) => e.detail as string);
    expect(sends.length).toBe(2);
    expect(sends[0]).toBe('build:write the failing test');
    expect(sends[1]).toContain('write the failing test');
    expect(sends[1]).toContain('previous attempt failed');
    expect(namesTheEmptyRedPhase(sends[1] as string)).toBe(true);

    // ── the settled failure is attributed to the red gate and carries the same
    // evidence into the journal, so nobody debugs it blind.
    const verdict = h.emitted.find((v) => v.node === 'n1');
    expect(verdict?.status).toBe('failed');
    expect(verdict?.evidence.gate?.ran).toBe('runtests');
    expect(verdict?.evidence.gate?.exitCode).not.toBe(0);
    const journalled = h.journal.find((e) => e.event === 'verdict' && e.node === 'n1');
    const gate = journalled?.gate as { outputTail?: string } | undefined;
    expect(namesTheEmptyRedPhase(gate?.outputTail ?? '')).toBe(true);
  });

  test('a first-attempt exhaustion settles failed without a seal', async () => {
    const h = makeHarness({
      changedByNode: { n2: [] },
      waitScript: () => stop({ filesTouched: [] }),
      // A red that ran and printed nothing. Not 127: a test runner that cannot
      // be spawned is the environment's fault and settles before any seal is
      // considered (D19, test/loop/gate-cannot-exec.test.ts).
      execScript: (argv) =>
        argv[0] === 'runtests' ? { output: '', exitCode: 1 } : { output: '', exitCode: 0 },
    });
    const summary = await runPlan(plan([phasedNode('n2', 1)]), h.deps, OPTS);

    expect(summary.failed).toEqual(['n2']);
    expect(h.log.count('spawn:build', 'n2')).toBe(1);
    expect(h.journal.some((e) => e.event === 'phase-commit')).toBe(false);
    expect(h.log.count('commit')).toBe(0);
    // A red gate that printed nothing still names the empty phase — the
    // emptiness is pleach's own finding, not a tail of the command's output.
    const journalled = h.journal.find((e) => e.event === 'verdict' && e.node === 'n2');
    const gate = journalled?.gate as { outputTail?: string } | undefined;
    expect(namesTheEmptyRedPhase(gate?.outputTail ?? '')).toBe(true);
  });

  test('the file set is the union: a tree change with nothing reported still seals', async () => {
    // Guards the fix against reading only the worker's self-report. The worker
    // claims to have touched nothing; the tree says otherwise, so the red phase
    // is real and seals — exactly what the seal's own union rule says.
    let runs = 0;
    const h = makeHarness({
      changedByNode: { n3: ['test/mod.test.ts'] },
      waitScript: () => stop({ filesTouched: [] }),
      execScript: (argv) => {
        if (argv[0] !== 'runtests') return { output: '', exitCode: 0 };
        runs += 1;
        return runs === 1
          ? { output: 'FAIL mod: not implemented', exitCode: 1 }
          : { output: 'ok 1 mod', exitCode: 0 };
      },
    });
    const summary = await runPlan(plan([phasedNode('n3', 1)]), h.deps, OPTS);

    expect(summary.closed).toEqual(['n3']);
    const sealed = h.journal.find((e) => e.event === 'phase-commit');
    expect(sealed?.phase).toBe('red');
    expect(sealed?.files).toEqual(['test/mod.test.ts']);
    expect(h.log.count('commit')).toBe(1);
  });
});
