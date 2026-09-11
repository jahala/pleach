// Ledger D21 (jahala/pleach#93): the work order tells a worker to write
// BLOCKED.md at the repo root when the plan cannot be finished here — what it
// tried, what stopped it, what a fix needs. Nothing read the file, so a node
// that explained itself ran the marker, staging, smoke and audit ladder over
// the explanation and was retried to write it again. A BLOCKED.md at the
// root of an attempt's tree is a verdict: the node settles `blocked` at once
// with the file's text as `blockedReason`, the tree (the file included — it is
// the evidence) quarantined, no retry. And a retry's re-prompt says it starts
// from the prompt and the evidence alone, because a note sent to the previous
// attempt did not survive it.
import { describe, expect, test } from 'bun:test';
import { PlanSchema, type Verdict } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, type HarnessOpts, makeHarness, stop } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };

const EXPLANATION = [
  '# Blocked',
  '',
  'Tried: wiring the importer to the vendor API; every call returns 401.',
  'Stopped by: no credentials for the sandbox in this environment.',
  'A fix needs: VENDOR_TOKEN provisioned for the worktree, then re-run.',
].join('\n');

const PASSING_AUDIT = '```tend-audit-result\n{"verdicts":[{"check":"c","verdict":"pass"}]}\n```';

const FRESH_START =
  'This attempt starts from the prompt and this evidence alone; notes sent to a previous attempt did not survive it.';

// x has every gate the ladder can run after a stop — smoke and a
// cross-provider audit — so "at once" is observable as none of them running;
// y stands on x, so a node that did not close must not feed it.
function plan() {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [
      {
        id: 'x',
        work: { prompt: 'build x' },
        accept: { smoke: 'run-smoke', audit: { command: 'tend audit x', provider: 'codex' } },
        policy: { maxAttempts: 3 },
      },
      { id: 'y', work: { prompt: 'build y' }, needs: ['x'], policy: { maxAttempts: 1 } },
    ],
  });
}

// A builder that, on the given build attempts (0-based), writes BLOCKED.md at
// the root of the tree it was spawned in and stops, the way the work order asks.
function harness(text: string, blocksOn: (spawnIndex: number) => boolean, over: HarnessOpts = {}) {
  const h: Harness = makeHarness({
    changedByNode: { x: ['src/feature.ts'] },
    ...over,
    waitScript: (ctx) => {
      if (ctx.role === 'audit') return stop({ finalMessage: PASSING_AUDIT });
      if (ctx.node === 'x' && blocksOn(ctx.spawnIndex)) {
        h.git.writeBlocked(ctx.cwd, text);
        return stop({ finalMessage: 'Blocked — see BLOCKED.md.' });
      }
      return stop();
    },
  });
  return h;
}

function lastEmitted(h: Harness, node: string): Verdict {
  const v = h.emitted.filter((e) => e.node === node).at(-1);
  if (v === undefined) throw new Error(`no verdict emitted for ${node}`);
  return v;
}

// The prompts sent to a node's builders, in order.
function buildPrompts(h: Harness, node: string): string[] {
  return h.log
    .of('send')
    .filter((e) => e.node === node && e.detail?.startsWith('build:'))
    .map((e) => (e.detail ?? '').slice('build:'.length));
}

function smokeRuns(h: Harness): number {
  return h.log.of('exec').filter((e) => e.detail === 'run-smoke').length;
}

// The first attempt's smoke is red on its run and on its one gate-only retry
// (D10), so the builder is re-prompted with the failure; green after that.
function smokeRedOnFirstAttempt(): HarnessOpts['execScript'] {
  let smokes = 0;
  return (argv) => {
    if (argv[0] !== 'run-smoke') return { output: '', exitCode: 0 };
    smokes += 1;
    return smokes <= 2 ? { output: 'boom', exitCode: 1 } : { output: '', exitCode: 0 };
  };
}

describe('BLOCKED.md at the root of the tree is a verdict (D21)', () => {
  // ledger: D21
  test('the node settles blocked in one attempt with the file text as blockedReason', async () => {
    const h = harness(EXPLANATION, () => true);

    const summary = await runPlan(plan(), h.deps, OPTS);

    expect(summary.blocked).toEqual(['x']);
    expect(summary.failed).toEqual([]);
    expect(summary.closed).toEqual([]);
    expect(summary.skipped).toEqual(['y']);

    const verdict = lastEmitted(h, 'x');
    expect(verdict.status).toBe('blocked');
    expect(verdict.evidence.blockedReason).toBe(EXPLANATION);
    expect(verdict.attempts).toBe(1);
    expect(h.journal.find((e) => e.event === 'blocked' && e.node === 'x')?.reason).toBe(
      EXPLANATION,
    );

    // At once, and no retry: one builder, and nothing of the ladder after the
    // stop ran over the explanation — no marker scan, no smoke, no auditor.
    expect(h.log.count('spawn:build', 'x')).toBe(1);
    expect(h.log.count('scanMarkers')).toBe(0);
    expect(smokeRuns(h)).toBe(0);
    expect(h.log.count('spawn:audit', 'x')).toBe(0);
    expect(h.git.refs.has('node/x')).toBe(false);
  });

  // ledger: D21
  test('the tree is quarantined with BLOCKED.md in it, before it is disposed', async () => {
    const h = harness(EXPLANATION, () => true);

    const summary = await runPlan(plan(), h.deps, OPTS);

    expect(summary.quarantined).toEqual(['x']);
    const snapshotAt = h.log.first('snapshot', 'quarantine/x');
    expect(snapshotAt).toBeGreaterThan(-1);
    expect(snapshotAt).toBeLessThan(h.log.first('dispose', 'x'));
    const quarantineSha = h.git.refs.get('quarantine/x');
    if (quarantineSha === undefined) throw new Error('no quarantine/x snapshot');
    const quarantined = h.journal.find((e) => e.event === 'quarantined' && e.node === 'x');
    expect(quarantined?.sha).toBe(quarantineSha);

    // What the quarantine kept: the work, and the explanation beside it.
    const kept = h.log
      .of('stage')
      .filter((e) => e.at < snapshotAt)
      .at(-1)
      ?.detail?.split(':')[1]
      ?.split(',');
    expect(kept).toContain('src/feature.ts');
    expect(kept).toContain('BLOCKED.md');

    const receipt = h.receipts.get('x');
    if (receipt === undefined) throw new Error('a blocked node left no receipt');
    expect(receipt.facts.status).toBe('blocked');
    expect(receipt.refs?.quarantineBranch).toBe('quarantine/x');
    expect(receipt.refs?.quarantineSha).toBe(quarantineSha);
  });

  // ledger: D21
  test('a BLOCKED.md written on a retry settles that attempt, with no attempt after it', async () => {
    const h = harness(EXPLANATION, (spawnIndex) => spawnIndex === 1, {
      execScript: smokeRedOnFirstAttempt(),
    });

    const summary = await runPlan(plan(), h.deps, OPTS);

    expect(summary.blocked).toEqual(['x']);
    const verdict = lastEmitted(h, 'x');
    expect(verdict.status).toBe('blocked');
    expect(verdict.evidence.blockedReason).toBe(EXPLANATION);
    expect(verdict.attempts).toBe(2);
    expect(h.log.count('spawn:build', 'x')).toBe(2);
    // Only the first attempt's smoke and its gate-only retry: the blocked
    // attempt ran none.
    expect(smokeRuns(h)).toBe(2);
  });

  // ledger: D21
  test('a runaway BLOCKED.md is capped at its opening 4000 characters', async () => {
    // Prose written to be read top-down: the opening says what blocked it.
    const long = `${EXPLANATION}\n\n${'Log line from the failed call.\n'.repeat(400)}`;
    expect(long.length).toBeGreaterThan(4000);
    const h = harness(long, () => true);

    await runPlan(plan(), h.deps, OPTS);

    const reason = lastEmitted(h, 'x').evidence.blockedReason;
    expect(reason?.length).toBe(4000);
    expect(reason?.startsWith(EXPLANATION)).toBe(true);
    expect(long.startsWith(reason ?? '\0')).toBe(true);
    expect(h.journal.find((e) => e.event === 'blocked' && e.node === 'x')?.reason).toBe(reason);
  });

  // ledger: D21
  test('an empty BLOCKED.md still settles blocked, and the reason says it was empty', async () => {
    const h = harness('  \n', () => true);

    const summary = await runPlan(plan(), h.deps, OPTS);

    expect(summary.blocked).toEqual(['x']);
    expect(h.log.count('spawn:build', 'x')).toBe(1);
    // Absence of an explanation is named, never left blank.
    const reason = lastEmitted(h, 'x').evidence.blockedReason ?? '';
    expect(reason).toContain('BLOCKED.md');
    expect(reason).toContain('empty');
    expect(h.journal.find((e) => e.event === 'blocked' && e.node === 'x')?.reason).toBe(reason);
  });

  // ledger: D21 — the field case (docs/dogfood/*.md): a phased node's worker
  // finds no honest red to write, explains it in BLOCKED.md and stops. The red
  // gate would refuse the phase as already green and retry it; the phases
  // after it would build on the explanation. The node settles before either.
  test('a phased worker that writes BLOCKED.md in its red phase settles before the red gate', async () => {
    const h: Harness = makeHarness({
      changedByNode: { p: [] },
      // The suite already passes: a red gate that ran would refuse the phase.
      execScript: () => ({ output: '1 pass', exitCode: 0 }),
      waitScript: (ctx) => {
        h.git.writeBlocked(ctx.cwd, EXPLANATION);
        return stop({ finalMessage: 'No honest red exists here — see BLOCKED.md.' });
      },
    });
    const phased = PlanSchema.parse({
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
            ],
          },
          policy: { maxAttempts: 3 },
        },
      ],
    });

    const summary = await runPlan(phased, h.deps, OPTS);

    expect(summary.blocked).toEqual(['p']);
    expect(summary.quarantined).toEqual(['p']);
    const verdict = lastEmitted(h, 'p');
    expect(verdict.status).toBe('blocked');
    expect(verdict.evidence.blockedReason).toBe(EXPLANATION);
    expect(verdict.attempts).toBe(1);
    expect(h.log.count('spawn:build', 'p')).toBe(1);
    expect(buildPrompts(h, 'p')).toEqual(['write the failing test']);
    expect(h.log.of('exec').filter((e) => e.detail === 'runtests').length).toBe(0);
    expect(h.journal.some((e) => e.event === 'phase-commit')).toBe(false);
  });

  // ledger: D21
  test('a normal stop is unchanged, and a BLOCKED.md below the root is ordinary work', async () => {
    const h = harness(EXPLANATION, () => false, {
      changedByNode: { x: ['src/feature.ts', 'docs/BLOCKED.md'] },
    });

    const summary = await runPlan(plan(), h.deps, OPTS);

    expect(summary.closed).toEqual(['x', 'y']);
    expect(summary.blocked).toEqual([]);
    expect(summary.quarantined).toEqual([]);
    expect(lastEmitted(h, 'x').status).toBe('done');
    expect(h.log.count('spawn:build', 'x')).toBe(1);
    expect(smokeRuns(h)).toBe(1);
    expect(h.log.count('spawn:audit', 'x')).toBe(1);
    expect(h.git.refs.has('node/x')).toBe(true);
  });
});

describe('a retry starts from the prompt alone (D21)', () => {
  // ledger: D21
  test("the re-prompt says so; the first attempt's prompt has nothing to say it about", async () => {
    const h = harness(EXPLANATION, () => false, { execScript: smokeRedOnFirstAttempt() });

    const summary = await runPlan(plan(), h.deps, OPTS);

    expect(summary.closed).toContain('x');
    const [first, retry] = buildPrompts(h, 'x');
    expect(first).toBe('build x');
    expect(retry).toStartWith(
      'build x\n\n--- previous attempt failed; fix this and continue ---\n',
    );
    expect(retry).toContain(FRESH_START);
    // Beside the failure's own evidence, never instead of it.
    expect(retry).toContain('boom');
  });
});
