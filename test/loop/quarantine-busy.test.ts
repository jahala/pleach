// Findings #12/#13 from the product-build reruns:
// #12 — the quarantine branch can be checked out in a human's worktree (the
// owner exploring the failed product!); a busy-branch refusal must fall back
// to a suffixed ref, never evaporate the evidence.
// #13 — an unparseable audit egress is undiagnosable unless the auditor's raw
// message reaches the journal; keep it (capped), per reaudit attempt.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness, stop } from './harness.ts';

const OPTS = { repoRoot: '/r' };

describe('quarantine busy-branch fallback (#12)', () => {
  test('a checked-out quarantine branch falls back to a suffixed ref', async () => {
    const h = makeHarness({
      changedByNode: { x: ['src/broken.ts'] },
      execScript: (argv) =>
        argv[0] === 'failing-tool' ? { output: 'boom', exitCode: 1 } : { output: '', exitCode: 0 },
      commitBranchBusy: (branch) => branch === 'quarantine/x',
    });
    const plan = PlanSchema.parse({
      goal: 'g',
      source: 's',
      nodes: [{ id: 'x', work: { command: 'failing-tool run' }, policy: { maxAttempts: 1 } }],
    });

    const summary = await runPlan(plan, h.deps, OPTS);

    expect(summary.quarantined).toEqual(['x']);
    const q = h.journal.find((e) => e.event === 'quarantined');
    expect(q?.branch).toBe('quarantine/x.2');
  });
});

describe('audit egress journaled on parse failure (#13)', () => {
  test('the raw auditor message reaches the journal, per reaudit attempt', async () => {
    const h = makeHarness({
      changedByNode: { x: ['src/x.ts'] },
      waitScript: () =>
        Promise.resolve({ ...stop(), finalMessage: 'codex said something with no fence at all' }),
    });
    const plan = PlanSchema.parse({
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

    const summary = await runPlan(plan, h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    const events = h.journal.filter((e) => e.event === 'audit-egress-unparseable');
    expect(events.length).toBe(2); // REAUDIT_BUDGET
    expect(String(events[0]?.egress)).toContain('no fence at all');
  });
});
