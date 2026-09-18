// Ledger D23 (jahala/pleach#120): a surprise in a node's run settles the node;
// it never drops the tree.
//
// The rule is the second half of the runner seam's section "A non-zero exit
// with a reason is a result" (contracts/runner.md on jahala/plotplot): "a
// surprise in any lane settles the node, tree quarantined and receipt written
// with the reason and a next step; it never drops the tree."
//
// On 2026-09-18 a seam error thrown from a wait escaped run-node, whose safety
// net disposed the live tree, and run-plan's catch journaled `failed` and
// returned before settle() — the only writer of the receipt and the quarantine.
// A green worker and a green smoke ended as `failed after 0 attempt(s)` with
// nothing kept; jahala/quadrat lost four verified trees in one night.
//
// The harness's seams are real implementations of the seam interfaces; the wait
// script throws what the umbel adapter throws when a wait yields no reason.
import { describe, expect, test } from 'bun:test';
import { WorkerSeamError } from '../../src/core/errors.ts';
import { PlanSchema, type Verdict } from '../../src/core/plan.ts';
import { rehash, sha256Hex } from '../../src/core/receipt.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, makeHarness, type SpawnCtx, stop } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };

const SEAM_TEXT = 'wait exited 1: umbel: tmux exploded';

// x builds and is audited; y stands on x, so a close that never happened must
// not feed it.
function plan() {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [
      {
        id: 'x',
        work: { prompt: 'build x' },
        accept: { smoke: 'run-smoke', audit: { command: 'tend audit x', provider: 'codex' } },
        policy: { maxAttempts: 1 },
      },
      { id: 'y', work: { prompt: 'build y' }, needs: ['x'], policy: { maxAttempts: 1 } },
    ],
  });
}

// The lane named throws the seam's error from its wait; every other wait stops.
function waitThrowsIn(role: SpawnCtx['role']) {
  return (ctx: SpawnCtx) => {
    if (ctx.role === role) throw new WorkerSeamError(SEAM_TEXT);
    return stop();
  };
}

function harness(role: SpawnCtx['role']): Harness {
  return makeHarness({
    auditProvider: 'codex',
    changedByNode: { x: ['src/feature.ts'] },
    waitScript: waitThrowsIn(role),
  });
}

function lastEmitted(h: Harness, node: string): Verdict {
  const v = h.emitted.filter((e) => e.node === node).at(-1);
  if (v === undefined) throw new Error(`no verdict emitted for ${node}`);
  return v;
}

function verdictLines(h: Harness, node: string): Record<string, unknown>[] {
  return h.journal.filter((e) => e.event === 'verdict' && e.node === node);
}

describe('a surprise in the audit lane, after a green worker and a green smoke (D23)', () => {
  // ledger: D23
  test('the node settles failed on a seam gate, the attempt counted, the text as the tail', async () => {
    const h = harness('audit');

    const summary = await runPlan(plan(), h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    expect(summary.closed).toEqual([]);
    expect(summary.skipped).toEqual(['y']);

    const verdict = lastEmitted(h, 'x');
    expect(verdict.status).toBe('failed');
    expect(verdict.attempts).toBe(1);
    expect(verdict.evidence.gate?.ran).toBe('seam:audit');
    expect(verdict.evidence.gate?.exitCode).toBe(-1);

    // One terminal verdict line, written by settle — never the bare line the
    // old catch wrote on its way out.
    const lines = verdictLines(h, 'x');
    expect(lines.length).toBe(1);
    const line = lines[0] as Record<string, unknown>;
    expect(line.status).toBe('failed');
    const gate = line.gate as { ran: string; exitCode: number; outputTail: string };
    expect(gate.ran).toBe('seam:audit');
    expect(gate.outputTail).toContain(SEAM_TEXT);
  });

  // ledger: D23
  test('the verdict says what to do next: re-run the audit alone over the kept tree', async () => {
    const h = harness('audit');

    await runPlan(plan(), h.deps, OPTS);

    const detail = String((verdictLines(h, 'x')[0] as Record<string, unknown>).detail);
    expect(detail).toContain(SEAM_TEXT);
    expect(detail).toContain('pleach audit');
  });

  // ledger: D23
  test('the tree is quarantined and the receipt says failed, names the seam and the quarantine', async () => {
    const h = harness('audit');

    const summary = await runPlan(plan(), h.deps, OPTS);

    expect(summary.quarantined).toEqual(['x']);
    expect(h.log.count('snapshot', 'quarantine/x')).toBe(1);
    const quarantineSha = h.git.refs.get('quarantine/x');
    if (quarantineSha === undefined) throw new Error('a surprise left no quarantine/x');

    const receipt = h.receipts.get('x');
    if (receipt === undefined) throw new Error('a surprise left no receipt');
    expect(rehash(receipt)).toBe(true);
    expect(receipt.facts.status).toBe('failed');
    expect(receipt.facts.attempts).toBe(1);
    expect(receipt.derived).toBe('quarantined');
    const seamGate = receipt.facts.gates.at(-1);
    expect(seamGate?.gate).toBe('seam:audit');
    expect(seamGate?.exitCode).toBe(-1);
    const tail = (verdictLines(h, 'x')[0]?.gate as { outputTail: string }).outputTail;
    expect(seamGate?.outputTailSha).toBe(sha256Hex(tail));
    // The smoke that passed before the surprise is still on the record.
    expect(receipt.facts.gates.some((g) => g.gate === 'smoke' && g.exitCode === 0)).toBe(true);
    expect(receipt.refs?.quarantineBranch).toBe('quarantine/x');
    expect(receipt.refs?.quarantineSha).toBe(quarantineSha);
  });

  // ledger: D23
  test('nothing is disposed before it is kept', async () => {
    const h = harness('audit');

    await runPlan(plan(), h.deps, OPTS);

    const kept = h.log.first('snapshot', 'quarantine/x');
    const disposed = h.log.first('dispose-start', 'x');
    expect(kept).toBeGreaterThanOrEqual(0);
    expect(disposed).toBeGreaterThan(kept);
    expect(h.log.count('dispose-start', 'x')).toBe(1);
    // The auditor's session is not left running behind the surprise.
    expect(h.log.count('kill', 'x')).toBe(
      h.log.count('spawn:build', 'x') + h.log.count('spawn:audit', 'x'),
    );
  });
});

describe('a surprise in the worker lane (D23)', () => {
  // ledger: D23
  test('the unfinished tree is kept and the next step is a re-run, which resumes from it', async () => {
    const h = harness('build');

    const summary = await runPlan(plan(), h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    expect(summary.quarantined).toEqual(['x']);
    expect(h.git.refs.has('quarantine/x')).toBe(true);

    const verdict = lastEmitted(h, 'x');
    expect(verdict.attempts).toBe(1);
    expect(verdict.evidence.gate?.ran).toBe('seam:worker');

    const receipt = h.receipts.get('x');
    if (receipt === undefined) throw new Error('a surprise left no receipt');
    expect(receipt.facts.status).toBe('failed');
    expect(receipt.facts.attempts).toBe(1);

    const detail = String((verdictLines(h, 'x')[0] as Record<string, unknown>).detail);
    expect(detail).toContain(SEAM_TEXT);
    expect(detail).toContain('quarantine/x');
    expect(detail).not.toContain('pleach audit');
  });
});

describe('a surprise before any tree exists (D23)', () => {
  // ledger: D23
  test('the node still settles through settle: one failed verdict line, a receipt, nothing kept', async () => {
    const h = makeHarness({
      auditProvider: 'codex',
      isolateThrows: { x: new WorkerSeamError(SEAM_TEXT) },
    });

    const summary = await runPlan(plan(), h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    expect(summary.skipped).toEqual(['y']);
    expect(summary.quarantined).toEqual([]);
    expect(h.log.count('snapshot', 'quarantine/x')).toBe(0);
    expect(h.log.count('dispose-start', 'x')).toBe(0);

    expect(lastEmitted(h, 'x').status).toBe('failed');

    const lines = verdictLines(h, 'x');
    expect(lines.length).toBe(1);
    const line = lines[0] as Record<string, unknown>;
    expect(line.status).toBe('failed');
    expect(String(line.detail)).toContain(SEAM_TEXT);
    expect(line.provider).toBeDefined();
    expect(line.spawned).toBe(false);

    const receipt = h.receipts.get('x');
    if (receipt === undefined) throw new Error('a surprise before isolation left no receipt');
    expect(rehash(receipt)).toBe(true);
    expect(receipt.facts.status).toBe('failed');
    expect(receipt.refs?.quarantineBranch).toBeUndefined();
  });
});
