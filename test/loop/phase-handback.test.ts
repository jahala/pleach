// issue #125 — a phased node's handback carries every phase that ran in its
// final attempt, in order, under its own heading. Until now the handback was
// the LAST phase's closing message alone, so the impl phase's dated Tried line
// was lost. In-memory seams (harness.ts); the subject is the loop's collection
// and the settle path's assembly.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness, stop } from './harness.ts';

const OPTS = { repoRoot: '/repo', defaultTimeoutMs: 1000 };
const SOURCE = 'garden.tend.html';

function phasedNode(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    work: {
      test: 'runtests',
      phases: [
        { phase: 'red', prompt: 'write the failing test' },
        { phase: 'impl', prompt: 'make it pass' },
        { phase: 'green', prompt: 'run the suite' },
      ],
    },
    accept: {},
    policy: { maxAttempts: 1, onDead: 'resume', reauditWhen: ['compacted'] },
    ...extra,
  };
}

// The red gate must fail once then pass — one honest red/green cycle.
function redThenGreen(): (argv: readonly string[]) => { output: string; exitCode: number } {
  let runs = 0;
  return (argv) => {
    if (argv[0] !== 'runtests') return { output: '', exitCode: 0 };
    runs += 1;
    return runs === 1
      ? { output: 'FAIL x: not implemented', exitCode: 1 }
      : { output: 'ok 1 x', exitCode: 0 };
  };
}

describe('a phased node keeps every phase of its final attempt (issue #125)', () => {
  test('red/impl/green closing with three messages keeps all three, in order, under headings', async () => {
    const h = makeHarness({
      changedByNode: { x: ['work.out'] },
      waitScript: (_ctx, waitIndex) =>
        stop({
          finalMessage: ['red closing\n', 'impl closing\n', 'green closing\n'][waitIndex] ?? 'done',
        }),
      execScript: redThenGreen(),
    });

    const summary = await runPlan(
      PlanSchema.parse({ goal: 'g', source: SOURCE, nodes: [phasedNode('x')] }),
      h.deps,
      OPTS,
    );
    expect(summary.closed).toEqual(['x']);

    const path = h.receipts.get('x')?.artifacts?.handback;
    expect(path).toBeDefined();
    expect(h.artifacts.get(path as string)).toBe(
      '## red\nred closing\n\n## impl\nimpl closing\n\n## green\ngreen closing\n',
    );
  });

  test('a node resumed after its red seal keeps only impl and green', async () => {
    let attempt = 1;
    let testRuns = 0;
    const h = makeHarness({
      changedByNode: { x: ['work.out'] },
      waitScript: (ctx, waitIndex) => {
        if (ctx.spawnIndex === 0) {
          return stop({
            finalMessage: ['red one\n', 'impl one\n', 'green one\n'][waitIndex] ?? 'done',
          });
        }
        return stop({ finalMessage: ['impl two\n', 'green two\n'][waitIndex] ?? 'done' });
      },
      execScript: (argv) => {
        if (argv[0] === 'runtests') {
          testRuns += 1;
          return testRuns === 1
            ? { output: 'FAIL x: not implemented', exitCode: 1 }
            : { output: 'ok 1 x', exitCode: 0 };
        }
        if (argv[0] === 'weeder') {
          return attempt === 1
            ? { output: 'FAIL smoke', exitCode: 1 }
            : { output: 'ok smoke', exitCode: 0 };
        }
        return { output: '', exitCode: 0 };
      },
    });

    const plan = () =>
      PlanSchema.parse({
        goal: 'g',
        source: SOURCE,
        nodes: [phasedNode('x', { accept: { smoke: 'weeder check' } })],
      });

    const first = await runPlan(plan(), h.deps, OPTS);
    expect(first.failed).toEqual(['x']);
    expect(h.journal.filter((e) => e.event === 'phase-commit')).toHaveLength(1);

    attempt = 2;
    const second = await runPlan(plan(), h.deps, OPTS);
    expect(second.closed).toEqual(['x']);

    const path = h.receipts.get('x')?.artifacts?.handback;
    expect(path).toBeDefined();
    const bytes = h.artifacts.get(path as string);
    expect(bytes).toContain('## impl\nimpl two\n');
    expect(bytes).toContain('## green\ngreen two\n');
    expect(bytes).not.toContain('## red');
    expect(bytes).not.toContain('impl one');
  });

  test("a prompt node's handback is unchanged — the message alone, no heading", async () => {
    const message = 'Kept the prompt handback verbatim.\n\nTried: 2026-10-26 did the work.\n';
    const h = makeHarness({
      waitScript: (ctx) =>
        ctx.role === 'audit'
          ? stop({
              finalMessage:
                '```tend-audit-result\n{"verdicts":[{"check":"c","verdict":"pass"}]}\n```',
            })
          : stop({ finalMessage: message }),
    });

    const summary = await runPlan(
      PlanSchema.parse({
        goal: 'g',
        source: SOURCE,
        nodes: [{ id: 'p', work: { prompt: 'build p' }, accept: {}, policy: { maxAttempts: 1 } }],
      }),
      h.deps,
      OPTS,
    );
    expect(summary.closed).toEqual(['p']);

    const path = h.receipts.get('p')?.artifacts?.handback;
    expect(path).toBeDefined();
    expect(h.artifacts.get(path as string)).toBe(message);
  });
});
