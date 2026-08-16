// SEC4a in the ladder: a node whose worker touched a file named in its
// audit.command must NOT reach the auditor — retryable with revert evidence,
// terminal failure (quarantined) at maxAttempts. In-memory seams.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness } from './harness.ts';

function auditedPlan(maxAttempts: number) {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [
      {
        id: 'x',
        work: { prompt: 'build x' },
        accept: { audit: { command: 'bash git-audit.sh c1', provider: 'codex' } },
        policy: { maxAttempts },
      },
    ],
  });
}

const OPTS = { repoRoot: '/r' };

describe('gate integrity (SEC4a)', () => {
  test('a touched audit script fails the node without spawning the auditor; evidence quarantined', async () => {
    const h = makeHarness({ changedByNode: { x: ['git-audit.sh', 'src/x.ts'] } });

    const summary = await runPlan(auditedPlan(1), h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    expect(summary.quarantined).toEqual(['x']);
    expect(h.git.refs.has('node/x')).toBe(false);
    // The tampered gate never ran: no audit worker was spawned.
    expect(h.log.count('spawn:audit')).toBe(0);
    // The verdict names the tampering.
    const verdict = h.emitted.find((v) => v.node === 'x');
    expect(verdict?.evidence.gate?.ran).toContain('tampered');
  });

  test('retry carries revert evidence to the builder before failing terminally', async () => {
    const h = makeHarness({ changedByNode: { x: ['git-audit.sh'] } });

    const summary = await runPlan(auditedPlan(2), h.deps, OPTS);

    expect(summary.failed).toEqual(['x']);
    expect(h.log.count('spawn:build')).toBe(2);
    const retrySend = h.log
      .of('send')
      .some(
        (e) => e.detail?.includes('git-audit.sh') && e.detail?.toLowerCase().includes('revert'),
      );
    expect(retrySend).toBe(true);
    expect(h.log.count('spawn:audit')).toBe(0);
  });

  test('an untouched audit script audits and closes normally', async () => {
    const h = makeHarness({ changedByNode: { x: ['src/x.ts'] } });

    const summary = await runPlan(auditedPlan(1), h.deps, OPTS);

    expect(summary.closed).toEqual(['x']);
    expect(h.log.count('spawn:audit')).toBe(1);
  });
});
