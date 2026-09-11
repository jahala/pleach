// Ledger D21 (jahala/pleach#96): a planted repository's pre-commit hook
// refused every commit in a fresh worktree, and settle's commit failure
// disposed a finished build with no node branch, no quarantine and no receipt.
// A hook is the repository's own gate, so the verified commit keeps running
// it; a refusal is a gate verdict like any other. The node settles failed with
// `gate.ran: 'commit'` and the hook's output as the tail, the tree is kept by a
// snapshot no hook can refuse, the receipt says failed and names the
// quarantine, and only then does the tree go. An auditor's late markers fail
// the same close, and keep the tree the same way.
import { describe, expect, test } from 'bun:test';
import { PlanSchema, type Verdict } from '../../src/core/plan.ts';
import { rehash, sha256Hex } from '../../src/core/receipt.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, makeHarness, stop } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };

const HOOK = [
  '✖ eslint --fix:',
  '  src/feature.ts',
  '    3:7  error  "unused" is assigned a value but never used  no-unused-vars',
  'husky - pre-commit hook exited with code 1 (error)',
].join('\n');

// x builds; y stands on x, so a close that never happened must not feed it.
function plan() {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [
      { id: 'x', work: { prompt: 'build x' }, policy: { maxAttempts: 1 } },
      { id: 'y', work: { prompt: 'build y' }, needs: ['x'], policy: { maxAttempts: 1 } },
    ],
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

describe('a refused verified commit is a gate verdict (D21)', () => {
  // ledger: D21
  test('the node settles failed on the commit gate with the hook output as the tail', async () => {
    const h = makeHarness({ changedByNode: { x: ['src/feature.ts'] }, commitBranchThrows: HOOK });

    const summary = await runPlan(plan(), h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    expect(summary.closed).toEqual([]);
    expect(summary.skipped).toEqual(['y']);
    // The commit was attempted — through the hooks — and refused.
    expect(h.log.count('commitBranch-refused', 'node/x')).toBe(1);
    expect(h.git.refs.has('node/x')).toBe(false);

    const verdict = lastEmitted(h, 'x');
    expect(verdict.status).toBe('failed');
    expect(verdict.evidence.gate).toEqual({ ran: 'commit', exitCode: -1 });
    expect(verdict.evidence.diffRef).toBeUndefined();

    // One terminal verdict per settle: a journal that said `done` and then
    // `failed` would count the node's cost twice and report a close that never
    // happened.
    const lines = verdictLines(h, 'x');
    expect(lines.length).toBe(1);
    const line = lines[0] as Record<string, unknown>;
    expect(line.status).toBe('failed');
    const gate = line.gate as { ran: string; exitCode: number; outputTail: string };
    expect(gate.ran).toBe('commit');
    expect(gate.exitCode).toBe(-1);
    expect(gate.outputTail).toContain(HOOK);
    expect(
      h.journal.some((e) => e.event === 'gate-fail' && e.node === 'x' && e.gate === 'commit'),
    ).toBe(true);
  });

  // ledger: D21
  test('the tree is quarantined by snapshot and the receipt says failed and names it', async () => {
    const h = makeHarness({ changedByNode: { x: ['src/feature.ts'] }, commitBranchThrows: HOOK });

    const summary = await runPlan(plan(), h.deps, OPTS);

    expect(summary.quarantined).toEqual(['x']);
    expect(h.log.count('snapshot', 'quarantine/x')).toBe(1);
    const quarantineSha = h.git.refs.get('quarantine/x');
    if (quarantineSha === undefined) throw new Error('no quarantine/x snapshot');
    const quarantined = h.journal.find((e) => e.event === 'quarantined' && e.node === 'x');
    expect(quarantined?.branch).toBe('quarantine/x');
    expect(quarantined?.sha).toBe(quarantineSha);

    const receipt = h.receipts.get('x');
    if (receipt === undefined) throw new Error('a refused commit left no receipt');
    expect(rehash(receipt)).toBe(true);
    expect(receipt.facts.status).toBe('failed');
    expect(receipt.derived).toBe('quarantined');
    const commitGate = receipt.facts.gates.at(-1);
    expect(commitGate?.gate).toBe('commit');
    expect(commitGate?.exitCode).toBe(-1);
    // The sealed pointer is to the very tail the journal keeps.
    const tail = (verdictLines(h, 'x')[0]?.gate as { outputTail: string }).outputTail;
    expect(commitGate?.outputTailSha).toBe(sha256Hex(tail));
    expect(receipt.refs?.quarantineBranch).toBe('quarantine/x');
    expect(receipt.refs?.quarantineSha).toBe(quarantineSha);
    expect(receipt.refs?.diffRef).toBeUndefined();
    // The receipt the store holds is the one the quarantine commit pins.
    expect(h.git.commitMessages.get('quarantine/x')).toContain(`receipt-sha256: ${receipt.sha256}`);
    expect(h.journal.some((e) => e.event === 'receipt' && e.sha256 === receipt.sha256)).toBe(true);
  });

  // ledger: D21
  test('nothing is disposed before it is kept', async () => {
    const h = makeHarness({ changedByNode: { x: ['src/feature.ts'] }, commitBranchThrows: HOOK });

    await runPlan(plan(), h.deps, OPTS);

    const refused = h.log.first('commitBranch-refused', 'node/x');
    const kept = h.log.first('snapshot', 'quarantine/x');
    const disposed = h.log.first('dispose-start', 'x');
    expect(refused).toBeGreaterThanOrEqual(0);
    expect(kept).toBeGreaterThan(refused);
    expect(disposed).toBeGreaterThan(kept);
    expect(h.log.count('dispose-start', 'x')).toBe(1);
  });

  // ledger: D21
  test('a long hook output is kept from its end, capped at 2000 characters', async () => {
    const noise = Array.from({ length: 200 }, (_, i) => `  src/f${i}.ts: warning`).join('\n');
    const last = 'husky - pre-commit hook exited with code 1 (error)';
    const h = makeHarness({
      changedByNode: { x: ['src/feature.ts'] },
      commitBranchThrows: `${noise}\n${last}`,
    });

    await runPlan(plan(), h.deps, OPTS);

    const gate = verdictLines(h, 'x').at(-1)?.gate as { outputTail: string } | undefined;
    if (gate === undefined) throw new Error('no gate on the verdict line');
    expect(gate.outputTail.length).toBeLessThanOrEqual(2000);
    expect(gate.outputTail.endsWith(last)).toBe(true);
    expect(gate.outputTail).not.toContain('src/f0.ts');
  });
});

describe('late markers fail the close the same way (D21)', () => {
  // ledger: D21
  test("an auditor's markers after the gate keep the tree before it is disposed", async () => {
    // The auditor shares the builder's cwd — the harness names the first
    // isolation of x `/wt/x/1` — and drops a conflict-marker file there after
    // the in-node marker gate has already passed.
    const h: Harness = makeHarness({
      changedByNode: { x: ['src/feature.ts'] },
      waitScript: (ctx) => {
        if (ctx.role === 'build') return stop();
        h.git.markers.set('/wt/x/1', ['src/feature.ts']);
        return stop({
          finalMessage: '```tend-audit-result\n{"verdicts":[{"check":"c","verdict":"pass"}]}\n```',
        });
      },
    });
    const audited = PlanSchema.parse({
      goal: 'g',
      source: 's',
      nodes: [
        {
          id: 'x',
          work: { prompt: 'build x' },
          accept: { audit: { command: 'bash audit.sh', provider: 'codex' } },
          policy: { maxAttempts: 1 },
        },
      ],
    });

    const summary = await runPlan(audited, h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    expect(h.git.refs.has('node/x')).toBe(false);
    expect(lastEmitted(h, 'x').evidence.gate).toEqual({ ran: 'marker', exitCode: -1 });

    const kept = h.log.first('snapshot', 'quarantine/x');
    expect(kept).toBeGreaterThanOrEqual(0);
    expect(h.log.first('dispose-start', 'x')).toBeGreaterThan(kept);
    const receipt = h.receipts.get('x');
    if (receipt === undefined) throw new Error('late markers left no receipt');
    expect(receipt.facts.status).toBe('failed');
    expect(receipt.refs?.quarantineBranch).toBe('quarantine/x');
  });
});
