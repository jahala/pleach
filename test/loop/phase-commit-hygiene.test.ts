// ledger: D13 — the seal is gated exactly like the close.
//
// The red-phase seal (test/loop/phase-commit.test.ts) mints a commit that
// `weeder bite` will check out and rerun, and the close's commit stacks on it.
// A commit made before the close's scans is a commit the close can never take
// back: conflict markers sealed into the red state make a history nobody can
// build, and a credential sealed there is compromised the moment node/<id>
// publishes — the close's hygiene battery would then be gating a leak that is
// already a parent of the verified commit.
//
// So the seal runs the close's two deterministic scans over the red files
// before it commits: the conflict-marker scan (gate `marker`) and the whole
// hygiene battery over the staged red diff (gate `hygiene:<kind>`). Both fail
// through the ladder's existing gate path — evidence into the next prompt, same
// tree, restart at red — and neither leaves a commit behind. A clean red seals
// as before.
//
// In-memory seams (harness.ts); the subject is the loop's phase ladder. The two
// commit kinds the harness records separately matter here: EventLog 'commit' is
// the detached seal, 'commitBranch' is a branch move (the close's node/<id>, or
// the quarantine ref a failed node's evidence lands on).
import { describe, expect, test } from 'bun:test';
import type { Plan } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, makeHarness, makeNode, stop } from './harness.ts';

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

// The red gate's own condition is met throughout these tests: the test command
// runs and fails, as a red must. What stops the seal is the scan, never the
// gate upstream of it.
const redFails = (argv: readonly string[]) =>
  argv[0] === 'runtests'
    ? { output: 'FAIL widget: not implemented', exitCode: 1 }
    : { output: '', exitCode: 0 };

// A live-shaped AWS key id, assembled at runtime from its two halves: the
// detector matches `AKIA` + 16 upper/digits, and this repo gates its own diffs
// with this battery — a literal fixture here is an added line the gate reads as
// a leak, so the file that proves the gate would fail it. Not AWS's documented
// example: that one is allowlisted (D19, test/unit/hygiene-allowlist.test.ts).
const AWS_KEY_PREFIX = 'AKIA';
const AWS_KEY_BODY = 'Q3VZ7K2MXW9RT4LB';
const SECRET_DIFF = `+++ b/test/auth.test.ts\n+const k = "${AWS_KEY_PREFIX}${AWS_KEY_BODY}";\n`;

// Every build prompt the node sent, in order, as the harness recorded them
// (`build:<text>`).
function buildSends(h: Harness, node: string): string[] {
  return h.log.events
    .filter((e) => e.kind === 'send' && e.node === node)
    .map((e) => e.detail as string);
}

// The seal refused: no detached commit, no phase-commit journal entry, and the
// ladder stopped there — the impl prompt never went out, so nothing but the red
// phase's own work was ever in the tree.
function expectNothingSealed(h: Harness, node: string): void {
  expect(h.journal.some((e) => e.event === 'phase-commit')).toBe(false);
  expect(h.log.count('commit')).toBe(0);
  expect(h.git.refs.has(`node/${node}`)).toBe(false);
  expect(h.log.events.some((e) => e.kind === 'send' && e.detail === 'build:make it pass')).toBe(
    false,
  );
}

// The gate the settled verdict names, and the evidence the journal kept.
function gateOf(h: Harness, node: string): { ran?: string; exitCode?: number; tail: string } {
  const verdict = h.emitted.find((v) => v.node === node);
  const journalled = h.journal.find((e) => e.event === 'verdict' && e.node === node);
  const gate = journalled?.gate as { outputTail?: string } | undefined;
  return { ...(verdict?.evidence.gate ?? {}), tail: gate?.outputTail ?? '' };
}

describe('phase commit (D13) — the seal is gated like the close', () => {
  test('conflict markers in the red tree fail `marker`: no commit, retried at red', async () => {
    const h = makeHarness({
      changedByNode: { n1: ['test/widget.test.ts'] },
      // The red phase resolved its merge by leaving the markers in the test.
      markersByNode: { n1: ['test/widget.test.ts'] },
      waitScript: () => stop({ filesTouched: ['test/widget.test.ts'] }),
      execScript: redFails,
    });
    const summary = await runPlan(plan([phasedNode('n1', 2)]), h.deps, OPTS);

    expect(summary.closed).toEqual([]);
    expect(summary.failed).toEqual(['n1']);
    expectNothingSealed(h, 'n1');

    // ── the green gate never ran either: one test run per attempt, the red
    // gate's own.
    expect(h.log.of('exec').filter((e) => e.detail === 'runtests').length).toBe(2);

    // ── retryable like the close's marker gate: one tree, re-prompted from the
    // red phase, evidence naming the files that still hold markers (A3).
    expect(h.log.count('isolate', 'n1')).toBe(1);
    expect(h.log.count('spawn:build', 'n1')).toBe(2);
    const sends = buildSends(h, 'n1');
    expect(sends.length).toBe(2);
    expect(sends[0]).toBe('build:write the failing test');
    expect(sends[1]).toContain('write the failing test');
    expect(sends[1]).toContain('previous attempt failed');
    expect(sends[1]).toContain('test/widget.test.ts');
    expect(/marker/i.test(sends[1] as string)).toBe(true);

    // ── the settled failure is attributed exactly as the close attributes it.
    expect(h.emitted.find((v) => v.node === 'n1')?.status).toBe('failed');
    const gate = gateOf(h, 'n1');
    expect({ ran: gate.ran, exitCode: gate.exitCode }).toEqual({ ran: 'marker', exitCode: -1 });
  });

  test('a secret in the red diff fails `hygiene:secret`: no commit, evidence names the leak', async () => {
    const h = makeHarness({
      changedByNode: { n2: ['test/auth.test.ts'] },
      stagedDiffByNode: { n2: SECRET_DIFF },
      waitScript: () => stop({ filesTouched: ['test/auth.test.ts'] }),
      execScript: redFails,
    });
    const summary = await runPlan(plan([phasedNode('n2', 1)]), h.deps, OPTS);

    expect(summary.closed).toEqual([]);
    expect(summary.failed).toEqual(['n2']);
    // ── the credential never reached a commit.
    expectNothingSealed(h, 'n2');

    // ── the same gate label the close records, and the battery's own evidence
    // (what was found, and where) kept for the operator.
    const gate = gateOf(h, 'n2');
    expect({ ran: gate.ran, exitCode: gate.exitCode }).toEqual({
      ran: 'hygiene:secret',
      exitCode: -1,
    });
    expect(gate.tail).toContain('AWS access key');
    expect(gate.tail).toContain('test/auth.test.ts');
  });

  test('a secret in the red diff is retryable in the same tree, restarting at red', async () => {
    const h = makeHarness({
      changedByNode: { n3: ['test/auth.test.ts'] },
      stagedDiffByNode: { n3: SECRET_DIFF },
      waitScript: () => stop({ filesTouched: ['test/auth.test.ts'] }),
      execScript: redFails,
    });
    const summary = await runPlan(plan([phasedNode('n3', 2)]), h.deps, OPTS);

    expect(summary.failed).toEqual(['n3']);
    expect(h.log.count('isolate', 'n3')).toBe(1);
    expect(h.log.count('spawn:build', 'n3')).toBe(2);
    expect(h.log.count('commit')).toBe(0);
    const sends = buildSends(h, 'n3');
    expect(sends.length).toBe(2);
    expect(sends[1]).toContain('write the failing test');
    expect(sends[1]).toContain('AWS access key');
  });

  test('the whole battery guards the seal: a bulk deletion fails `hygiene:deletion`', async () => {
    const h = makeHarness({
      changedByNode: { n4: ['test/widget.test.ts'] },
      stagedDiffByNode: { n4: '+++ b/test/widget.test.ts\n+expect(widget()).toBe(1);\n' },
      // The red phase rewrote the suite, dropping most of it — and the worker's
      // final message ('done') never says so, which is what the tripwire is for.
      stagedNumstatByNode: { n4: [{ file: 'test/widget.test.ts', added: 4, deleted: 400 }] },
      waitScript: () => stop({ filesTouched: ['test/widget.test.ts'] }),
      execScript: redFails,
    });
    const summary = await runPlan(plan([phasedNode('n4', 1)]), h.deps, OPTS);

    expect(summary.failed).toEqual(['n4']);
    expectNothingSealed(h, 'n4');
    const gate = gateOf(h, 'n4');
    expect({ ran: gate.ran, exitCode: gate.exitCode }).toEqual({
      ran: 'hygiene:deletion',
      exitCode: -1,
    });
    expect(gate.tail).toContain('test/widget.test.ts');
  });

  test('a clean red still seals: one detached commit, then the close on top', async () => {
    let runs = 0;
    const h = makeHarness({
      changedByNode: { n5: ['test/widget.test.ts'] },
      stagedDiffByNode: { n5: '+++ b/test/widget.test.ts\n+expect(widget()).toBe(1);\n' },
      waitScript: (_ctx, waitIndex) =>
        stop({ filesTouched: waitIndex === 0 ? ['test/widget.test.ts'] : ['src/widget.ts'] }),
      execScript: (argv) => {
        if (argv[0] !== 'runtests') return { output: '', exitCode: 0 };
        runs += 1;
        return runs === 1
          ? { output: 'FAIL widget: not implemented', exitCode: 1 }
          : { output: 'ok 1 widget', exitCode: 0 };
      },
    });
    const summary = await runPlan(plan([phasedNode('n5', 1)]), h.deps, OPTS);

    expect(summary.closed).toEqual(['n5']);
    const sealed = h.journal.find((e) => e.event === 'phase-commit');
    expect(sealed?.phase).toBe('red');
    expect(sealed?.files).toEqual(['test/widget.test.ts']);
    expect(h.log.count('commit')).toBe(1);
    expect(h.git.refs.has('node/n5')).toBe(true);
    // The scans that guard the seal cost a clean red nothing: it went on to the
    // impl prompt and published.
    expect(h.log.events.some((e) => e.kind === 'send' && e.detail === 'build:make it pass')).toBe(
      true,
    );
  });
});
