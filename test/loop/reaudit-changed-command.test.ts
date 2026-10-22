// ledger: D39
// ledger: D17 — `pleach audit` refuses re-asking the same question, and lets a
// changed audit command through (jahala/pleach#154).
//
// A node whose audit failed at the egress is quarantined with its smoke green.
// The first re-audit re-runs the audit on that tree. A SECOND re-audit under
// the SAME command is the same question asked again — refused, naming that the
// command is unchanged. After the plan's `accept.audit.command` changes, the
// re-audit is a different audit and is allowed to run (and close the node).
//
// A receipt minted before the command was recorded on the close has nothing to
// compare against: the re-audit is allowed once, and the close it writes
// records the command so the NEXT re-audit compares against it.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { mintReceipt } from '../../src/core/receipt.ts';
import { auditNode } from '../../src/loop/audit-node.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };

function plan(command: string) {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [
      {
        id: 'x',
        work: { prompt: 'build x' },
        accept: { smoke: 'smokey', audit: { command, provider: 'codex' } },
        policy: { maxAttempts: 1 },
      },
    ],
  });
}

const GARBAGE = 'the auditor spoke prose, not a tend-audit-result block';
const PASS = '```tend-audit-result\n{"verdicts":[{"check":"c","verdict":"pass"}]}\n```';

describe('a further re-audit requires a changed audit command (D17)', () => {
  test('the same command is refused; a changed command re-adjudicates and can close', async () => {
    let egress = GARBAGE;
    const h = makeHarness({ auditEgress: () => egress });

    const p = plan('audit x');
    const summary = await runPlan(p, h.deps, OPTS);
    expect(summary.quarantined).toEqual(['x']);

    // The first re-audit runs the same bad command and re-quarantines.
    const first = await auditNode(p, 'x', h.deps, { repoRoot: OPTS.repoRoot });
    expect(first.status).toBe('quarantined');

    // A second re-audit under the SAME command is refused, naming the command.
    await expect(auditNode(p, 'x', h.deps, { repoRoot: OPTS.repoRoot })).rejects.toMatchObject({
      name: 'AuditRefusedError',
      reason: expect.stringContaining('same audit command'),
    });

    // A changed command is a different audit: it runs, and it can close.
    egress = PASS;
    const closing = await auditNode(plan('audit x --fixed'), 'x', h.deps, {
      repoRoot: OPTS.repoRoot,
    });
    expect(closing.status).toBe('closed');
  });

  test('a re-audit whose receipt predates command recording may cross once', async () => {
    let egress = GARBAGE;
    const h = makeHarness({ auditEgress: () => egress });

    const p = plan('audit x');
    await runPlan(p, h.deps, OPTS);
    await auditNode(p, 'x', h.deps, { repoRoot: OPTS.repoRoot });

    // Model a receipt minted before the command was recorded: re-mint the same
    // facts without the field, so the seal stays consistent with what it holds.
    const stored = h.receipts.get('x');
    if (stored === undefined) throw new Error('the re-audit wrote no receipt');
    const { contractVersion: _cv, ...mint } = stored.facts;
    delete mint.auditCommand;
    h.receipts.set('x', { ...mintReceipt(mint), refs: stored.refs });

    // Nothing to compare against, so the re-audit is allowed once — and this
    // close records the command, so a further re-audit compares against it.
    egress = PASS;
    const result = await auditNode(p, 'x', h.deps, { repoRoot: OPTS.repoRoot });
    expect(result.status).toBe('closed');
  });
});
