// Ledger D16, the loop's half: a wait the run's OWN signal interrupts is not a
// node failure — it is an abort, and the work the node was holding survives it.
// Three occurrences in two days (jahala/pleach#61, #67, #72) settled a finished,
// staged build as `failed` and disposed the tree. Now the node settles with
// Verdict status 'aborted' and its gate named, the receipt always writes
// (derived 'quarantined'), the tree is committed to quarantine/<id> as it
// stands, and RunSummary.aborted names it so the exit code is not clean.
//
// In-memory seams per the testing doctrine: the harness's runner answers
// `aborted` when the wait's signal fires, which is what the real umbel adapter
// answers too (its own half is test/integration/umbel-abort.test.ts).
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { summaryExitCode } from '../../src/faces/cli.ts';
import type { WorkerResult } from '../../src/loop/deps.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness, stop } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };

// One node, and maxAttempts 2 deliberately: 'aborted' classifies terminal, so
// the node must settle on the first wait rather than re-prompt into the abort.
// One node also keeps `skipped` empty, so the exit code answers to `aborted`
// alone rather than to a queue the abort never reached.
function buildPlan() {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [{ id: 'x', work: { prompt: 'build x' }, policy: { maxAttempts: 2 } }],
  });
}

function auditedPlan() {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [
      {
        id: 'x',
        work: { prompt: 'build x' },
        accept: { audit: { command: 'bash git-audit.sh c1', provider: 'codex' } },
        policy: { maxAttempts: 2 },
      },
    ],
  });
}

// A wait that never returns on its own, with the run's signal firing inside it —
// the shape of a Ctrl-C landing while a worker is mid-turn.
function abortMidWait(controller: AbortController): Promise<WorkerResult> {
  controller.abort();
  return new Promise<WorkerResult>(() => {});
}

describe('an aborted wait settles as aborted and keeps the work (D16)', () => {
  test('build wait aborted → aborted verdict, receipt, quarantined tree, unclean exit', async () => {
    const controller = new AbortController();
    const h = makeHarness({
      // Real mid-turn work in the tree — staged and unstaged alike, which is
      // what the isolate seam's changedFiles reports (git status --porcelain).
      changedByNode: { x: ['src/wip.ts', 'docs/notes.md'] },
      waitScript: () => abortMidWait(controller),
    });

    const summary = await runPlan(buildPlan(), h.deps, { ...OPTS, signal: controller.signal });

    // The verdict names the abort and the wait it was interrupted in.
    const verdict = h.emitted.find((v) => v.node === 'x');
    expect(verdict?.status).toBe('aborted');
    expect(verdict?.evidence.gate).toEqual({ ran: 'wait:aborted', exitCode: -1 });
    // Terminal: an abort is never retried into the same dying run.
    expect(h.log.count('spawn:build', 'x')).toBe(1);

    // No terminal verdict without an artifact (D11): the receipt always writes.
    const receipt = h.receipts.get('x');
    if (receipt === undefined) throw new Error('aborted settle left no receipt');
    expect(receipt.facts.status).toBe('aborted');
    expect(receipt.derived).toBe('quarantined');
    expect(receipt.refs?.quarantineBranch).toBe('quarantine/x');

    // The tree as it stands: every changed path staged onto quarantine/<id>,
    // committed before the tree is disposed.
    expect(h.git.refs.has('quarantine/x')).toBe(true);
    const commitAt = h.log.first('snapshot', 'quarantine/x');
    expect(commitAt).toBeGreaterThan(-1);
    const quarantineStage = h.log
      .of('stage')
      .filter((e) => e.at < commitAt)
      .at(-1);
    expect(quarantineStage?.detail).toContain('src/wip.ts');
    expect(quarantineStage?.detail).toContain('docs/notes.md');
    expect(commitAt).toBeLessThan(h.log.first('dispose', 'x'));

    // The summary buckets it as aborted, not failed — and says so at run-end.
    expect(summary).toMatchObject({ aborted: ['x'], failed: [], quarantined: ['x'] });
    expect(h.journal.find((e) => e.event === 'run-end')?.aborted).toEqual(['x']);
    // Nothing was verified, so the run is not clean.
    expect(summaryExitCode(summary)).toBe(1);
  });

  test('audit wait aborted → aborted too, not a failed audit', async () => {
    const controller = new AbortController();
    const h = makeHarness({
      changedByNode: { x: ['src/x.ts'] },
      waitScript: (ctx) => (ctx.role === 'build' ? stop() : abortMidWait(controller)),
    });

    const summary = await runPlan(auditedPlan(), h.deps, { ...OPTS, signal: controller.signal });

    const verdict = h.emitted.find((v) => v.node === 'x');
    expect(verdict?.status).toBe('aborted');
    // The gate names the abort — the auditor never adjudicated anything.
    expect(verdict?.evidence.gate?.ran).toContain('aborted');
    expect(summary).toMatchObject({ aborted: ['x'], failed: [] });

    const receipt = h.receipts.get('x');
    if (receipt === undefined) throw new Error('aborted audit settle left no receipt');
    expect(receipt.facts.status).toBe('aborted');
    expect(receipt.derived).toBe('quarantined');
    // The build's work is not lost because its auditor was cut off mid-wait.
    expect(h.git.refs.has('quarantine/x')).toBe(true);
    expect(h.git.refs.has('node/x')).toBe(false);
    expect(summaryExitCode(summary)).toBe(1);
  });
});
