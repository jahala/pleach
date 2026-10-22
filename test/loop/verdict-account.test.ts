// issue #106 — a verdict that settled away from 'done' carries a non-empty
// reason and a non-empty nextStep on its journal line, derived from what the
// loop observed. The two cases the issue names: a node whose smoke gate fails
// in the ordinary way (the one an agent meets every day), and a blocked node
// whose runner reported no blocking prompt (the twenty-minute idle).
import { describe, expect, test } from 'bun:test';
import type { Plan } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness, makeNode, stop } from './harness.ts';

const REPO = '/repo';
const SRC = 'garden.tend.html';

function plan(over: Partial<Plan> & { nodes: Plan['nodes'] }): Plan {
  return { goal: 'g', source: SRC, ...over };
}

function verdictLine(h: ReturnType<typeof makeHarness>, node: string): Record<string, unknown> {
  const v = h.journal.find((e) => e.event === 'verdict' && e.node === node);
  if (v === undefined) throw new Error(`no verdict line for ${node}`);
  return v;
}

function nonEmpty(value: unknown): string {
  expect(typeof value).toBe('string');
  expect((value as string).length).toBeGreaterThan(0);
  return value as string;
}

describe('the journal verdict line carries reason and nextStep (issue #106)', () => {
  test('a node whose smoke gate fails in the ordinary way carries both', async () => {
    const h = makeHarness({
      execScript: (argv) =>
        argv.join(' ').includes('false')
          ? { output: 'boom', exitCode: 1 }
          : { output: '', exitCode: 0 },
    });
    const p = plan({
      nodes: [
        makeNode({
          id: 'n',
          accept: { smoke: 'false' },
          policy: { maxAttempts: 1, onDead: 'fail', reauditWhen: ['compacted'] },
        }),
      ],
    });

    await runPlan(p, h.deps, { repoRoot: REPO });

    const verdict = verdictLine(h, 'n');
    expect(verdict.status).toBe('failed');
    expect(nonEmpty(verdict.reason)).toContain('false');
    expect(nonEmpty(verdict.nextStep)).toContain('re-run the plan');
  });

  test('a blocked node whose blockedReason is absent still says what was observed', async () => {
    const h = makeHarness({
      waitScript: () => stop({ reason: 'idle' }),
    });
    const p = plan({
      nodes: [
        makeNode({
          id: 'n',
          policy: { maxAttempts: 1, onDead: 'fail', reauditWhen: ['compacted'] },
        }),
      ],
    });

    await runPlan(p, h.deps, { repoRoot: REPO });

    const verdict = verdictLine(h, 'n');
    expect(verdict.status).toBe('blocked');
    // No blockedReason on the line — the reason the issue saw as `?`.
    expect(verdict.blockedReason).toBeUndefined();
    expect(nonEmpty(verdict.reason)).toContain('no reason');
    expect(nonEmpty(verdict.nextStep)).toContain('re-run the plan');

    // The `blocked` event's reason is never empty either.
    const blocked = h.journal.find((e) => e.event === 'blocked' && e.node === 'n');
    expect(blocked).toBeDefined();
    expect(nonEmpty(blocked?.reason)).toContain('no reason');
  });

  test('an audit with no readable answer over a green build points at a re-audit', async () => {
    const h = makeHarness({
      changedByNode: { n: ['src/n.ts'] },
      waitScript: () => Promise.resolve({ ...stop(), finalMessage: 'no fence at all' }),
    });
    const p = plan({
      nodes: [
        makeNode({
          id: 'n',
          work: { prompt: 'build n' },
          accept: { audit: { command: 'bash audit.sh', provider: 'codex' } },
          policy: { maxAttempts: 1, onDead: 'fail', reauditWhen: ['compacted'] },
        }),
      ],
    });

    await runPlan(p, h.deps, { repoRoot: REPO });

    const verdict = verdictLine(h, 'n');
    expect(verdict.status).toBe('failed');
    expect(nonEmpty(verdict.reason)).toContain('egress unparseable');
    // The build is green; spend the auditor's turn again, never the build.
    expect(verdict.nextStep).toBe('pleach audit <plan.json> n');
  });

  test('a done verdict carries neither field', async () => {
    const h = makeHarness();
    const p = plan({ nodes: [makeNode({ id: 'n' })] });

    await runPlan(p, h.deps, { repoRoot: REPO });

    const verdict = verdictLine(h, 'n');
    expect(verdict.status).toBe('done');
    expect(verdict.reason).toBeUndefined();
    expect(verdict.nextStep).toBeUndefined();
  });
});
