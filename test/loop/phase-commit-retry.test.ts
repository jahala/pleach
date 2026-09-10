// ledger: D13 — a sealed red is never remade.
//
// The seal (test/loop/phase-commit.test.ts) turns the RED state into history
// the moment the RED gate passes. Everything after it runs on a tree that
// already holds the red commit, so a retryable failure downstream of the seal
// — a green gate that stayed red, a smoke, a hygiene hit — must NOT re-enter
// the red phase: the tree no longer holds only the failing test, so a second
// "red" would seal impl work under a `pleach-phase: red` trailer and lie about
// what ran red. The retry resumes at the phase after the red one and the
// evidence rides the first prompt it does send (A3).
//
// The state is per TREE, not per node. A red-gate failure happens BEFORE any
// seal, so its retry restarts at red exactly as before; and dead+resume throws
// the tree away, so the fresh one earns its own red phase and its own seal.
//
// In-memory seams (harness.ts); the subject is the loop's phase ladder across
// attempts. Real git parentage is proven in test/e2e/phase-commit.test.ts.
import { describe, expect, test } from 'bun:test';
import type { Plan } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, makeHarness, makeNode, stop } from './harness.ts';

const OPTS = { repoRoot: '/repo', defaultTimeoutMs: 1000 };

function plan(nodes: Plan['nodes']): Plan {
  return { goal: 'g', source: 'garden.tend.html', nodes };
}

const RED_PROMPT = 'write the failing test';
const IMPL_PROMPT = 'make it pass';
const GREEN_PROMPT = 'run the suite';

function phasedNode(id: string, maxAttempts: number) {
  return makeNode({
    id,
    work: {
      test: 'runtests',
      phases: [
        { phase: 'red', prompt: RED_PROMPT },
        { phase: 'impl', prompt: IMPL_PROMPT },
        { phase: 'green', prompt: GREEN_PROMPT },
      ],
    },
    policy: { maxAttempts, onDead: 'resume', reauditWhen: ['compacted'] },
  });
}

// Every prompt the node's build workers received, in order.
function buildSends(h: Harness, node: string): string[] {
  return h.log.events
    .filter((e) => e.kind === 'send' && e.node === node && (e.detail ?? '').startsWith('build:'))
    .map((e) => (e.detail as string).slice('build:'.length));
}

// The prompts the nth (0-based) build worker of a node received — the spawn
// boundary is the attempt boundary, so [0] is that attempt's first prompt.
function sendsOfSpawn(h: Harness, node: string, spawnIndex: number): string[] {
  const spawns = h.log.events.filter((e) => e.kind === 'spawn:build' && e.node === node);
  const from = spawns[spawnIndex]?.at ?? Number.MAX_SAFE_INTEGER;
  const to = spawns[spawnIndex + 1]?.at ?? Number.MAX_SAFE_INTEGER;
  return h.log.events
    .filter(
      (e) =>
        e.kind === 'send' &&
        e.node === node &&
        e.at > from &&
        e.at < to &&
        (e.detail ?? '').startsWith('build:'),
    )
    .map((e) => (e.detail as string).slice('build:'.length));
}

function runtestsRuns(h: Harness): number {
  return h.log.of('exec').filter((e) => e.detail === 'runtests').length;
}

describe('phase commit (D13) — a retry after a sealed red resumes at impl', () => {
  test('green gate fails → attempt 2 opens with the impl prompt and the evidence, one seal', async () => {
    let runs = 0;
    const h = makeHarness({
      changedByNode: { n1: ['test/widget.test.ts'] },
      waitScript: (_ctx, waitIndex) =>
        stop({ filesTouched: waitIndex === 0 ? ['test/widget.test.ts'] : ['src/widget.ts'] }),
      execScript: (argv) => {
        if (argv[0] !== 'runtests') return { output: '', exitCode: 0 };
        runs += 1;
        // 1: the red gate (must fail). 2: attempt 1's green gate, still red —
        // the retryable failure that lands downstream of the seal. 3: attempt
        // 2's green gate, now passing.
        if (runs === 1) return { output: 'FAIL widget: not implemented', exitCode: 1 };
        if (runs === 2) return { output: 'FAIL widget: still red after impl', exitCode: 1 };
        return { output: 'ok 1 widget', exitCode: 0 };
      },
    });
    const summary = await runPlan(plan([phasedNode('n1', 2)]), h.deps, OPTS);
    expect(summary.closed).toEqual(['n1']);

    // ── same tree, second builder: a retryable failure reuses the isolation.
    expect(h.log.count('isolate', 'n1')).toBe(1);
    expect(h.log.count('spawn:build', 'n1')).toBe(2);

    // ── the red phase happened exactly once in the run: one prompt, one gate
    // run, one seal, one commit on the detached HEAD.
    const sends = buildSends(h, 'n1');
    expect(sends.filter((s) => s.startsWith(RED_PROMPT)).length).toBe(1);
    expect(h.journal.filter((e) => e.event === 'phase-commit').length).toBe(1);
    expect(h.log.count('commit')).toBe(1);
    // red gate (attempt 1) + green gate (attempt 1) + green gate (attempt 2):
    // attempt 2 re-enters at impl, so the red gate never runs a second time.
    expect(runtestsRuns(h)).toBe(3);

    // ── attempt 2's FIRST prompt is the impl phase's, carrying the evidence
    // (A3) — a resume that dropped the evidence would re-prompt blind.
    const second = sendsOfSpawn(h, 'n1', 1);
    expect(second[0]?.startsWith(IMPL_PROMPT)).toBe(true);
    expect(second[0]).toContain('previous attempt failed');
    expect(second[0]).toContain('FAIL widget: still red after impl');
    expect(second).toEqual([expect.stringContaining(IMPL_PROMPT), GREEN_PROMPT]);

    // ── the settle stacks on the one red commit; nothing published the seal.
    const sealed = h.journal.find((e) => e.event === 'phase-commit');
    expect(sealed?.phase).toBe('red');
    expect(h.log.count('commitBranch')).toBe(1);
    expect([...h.git.refs.values()]).not.toContain(sealed?.sha as string);
    const closed = h.journal.find((e) => e.event === 'closed' && e.node === 'n1');
    expect(closed?.sha).toBe(h.git.refs.get('node/n1') as string);
    expect(closed?.sha).not.toBe(sealed?.sha);
  });

  test('the resume skips every phase up to and including red, not merely the first', async () => {
    // A red phase in the middle: the tree already holds the scaffold when the
    // seal happens, so re-running the scaffold prompt would redo sealed work.
    let runs = 0;
    const h = makeHarness({
      changedByNode: { n2: ['src/mod.ts', 'test/mod.test.ts'] },
      waitScript: () => stop({ filesTouched: [] }),
      execScript: (argv) => {
        if (argv[0] !== 'runtests') return { output: '', exitCode: 0 };
        runs += 1;
        if (runs === 1) return { output: 'FAIL mod: not implemented', exitCode: 1 };
        if (runs === 2) return { output: 'FAIL mod: still red after impl', exitCode: 1 };
        return { output: 'ok 1 mod', exitCode: 0 };
      },
    });
    const summary = await runPlan(
      plan([
        makeNode({
          id: 'n2',
          work: {
            test: 'runtests',
            phases: [
              { phase: 'impl', prompt: 'scaffold the module' },
              { phase: 'red', prompt: RED_PROMPT },
              { phase: 'impl', prompt: IMPL_PROMPT },
              { phase: 'green', prompt: GREEN_PROMPT },
            ],
          },
          policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
        }),
      ]),
      h.deps,
      OPTS,
    );
    expect(summary.closed).toEqual(['n2']);

    const sends = buildSends(h, 'n2');
    expect(sends.filter((s) => s.startsWith('scaffold the module')).length).toBe(1);
    expect(sends.filter((s) => s.startsWith(RED_PROMPT)).length).toBe(1);
    expect(h.log.count('commit')).toBe(1);
    expect(runtestsRuns(h)).toBe(3);

    const second = sendsOfSpawn(h, 'n2', 1);
    expect(second[0]?.startsWith(IMPL_PROMPT)).toBe(true);
    expect(second[0]).toContain('FAIL mod: still red after impl');
    expect(second).toEqual([expect.stringContaining(IMPL_PROMPT), GREEN_PROMPT]);
  });

  test('a red-gate failure — before any seal — restarts the next attempt at red', async () => {
    // The RED gate rejects a test that already passes. Nothing was sealed, so
    // the tree still holds only what the red phase wrote: the next attempt
    // must re-enter at red, exactly as it did before the seal existed.
    let runs = 0;
    const h = makeHarness({
      changedByNode: { n3: ['test/widget.test.ts'] },
      waitScript: () => stop({ filesTouched: ['test/widget.test.ts'] }),
      execScript: (argv) => {
        if (argv[0] !== 'runtests') return { output: '', exitCode: 0 };
        runs += 1;
        // 1: attempt 1's red gate PASSES — no failing test was written, so the
        // red gate fails and nothing seals. 2: attempt 2's red gate fails as a
        // red must. 3: attempt 2's green gate passes.
        if (runs === 1) return { output: 'ok 1 widget (already passing)', exitCode: 0 };
        if (runs === 2) return { output: 'FAIL widget: not implemented', exitCode: 1 };
        return { output: 'ok 1 widget', exitCode: 0 };
      },
    });
    const summary = await runPlan(plan([phasedNode('n3', 2)]), h.deps, OPTS);
    expect(summary.closed).toEqual(['n3']);

    // ── same tree, and attempt 2 opens at RED with the gate's evidence.
    expect(h.log.count('isolate', 'n3')).toBe(1);
    const second = sendsOfSpawn(h, 'n3', 1);
    expect(second[0]?.startsWith(RED_PROMPT)).toBe(true);
    expect(second[0]).toContain('previous attempt failed');
    expect(second[0]).toContain('already passing');

    // ── one seal in the run, made on attempt 2 — after the failed red gate,
    // never before it.
    expect(h.log.count('commit')).toBe(1);
    const seal = h.log.of('commit')[0]?.at ?? -1;
    const secondRedPrompt = h.log.events.find(
      (e) => e.kind === 'send' && e.node === 'n3' && (e.detail ?? '').includes('previous attempt'),
    );
    expect(seal).toBeGreaterThan(secondRedPrompt?.at ?? Number.MAX_SAFE_INTEGER);
    expect(h.journal.filter((e) => e.event === 'phase-commit').length).toBe(1);
  });

  test('dead + resume re-isolates: the fresh tree earns its own red phase and seal', async () => {
    // The seal state belongs to the TREE. onDead:'resume' disposes it and
    // isolates a new one, which holds nothing — so it must run red again and
    // seal again, or its history would have no failing-test commit at all.
    const perTree = new Map<string, number>();
    const h = makeHarness({
      changedByNode: { n4: ['test/widget.test.ts'] },
      waitScript: (ctx, waitIndex) =>
        // The first builder dies inside the impl phase, after its red sealed.
        ctx.spawnIndex === 0 && waitIndex === 1
          ? stop({ reason: 'dead' })
          : stop({ filesTouched: ['test/widget.test.ts'] }),
      execScript: (argv, cwd) => {
        if (argv[0] !== 'runtests') return { output: '', exitCode: 0 };
        const n = (perTree.get(cwd) ?? 0) + 1;
        perTree.set(cwd, n);
        // In each fresh tree the test is written first (red), then made to
        // pass (green) — one honest cycle per tree.
        return n === 1
          ? { output: 'FAIL widget: not implemented', exitCode: 1 }
          : { output: 'ok 1 widget', exitCode: 0 };
      },
    });
    // A dead provider is re-cast, not re-run (D17): the fresh tree is the
    // fallback's, which changes who builds and nothing about the seal.
    const summary = await runPlan(plan([phasedNode('n4', 2)]), h.deps, {
      ...OPTS,
      fallbackProvider: 'gemini',
    });
    expect(summary.closed).toEqual(['n4']);

    // ── two trees, two red phases, two seals with distinct shas.
    expect(h.log.count('isolate', 'n4')).toBe(2);
    const sends = buildSends(h, 'n4');
    expect(sends.filter((s) => s.startsWith(RED_PROMPT)).length).toBe(2);
    expect(sendsOfSpawn(h, 'n4', 1)[0]?.startsWith(RED_PROMPT)).toBe(true);
    const seals = h.journal.filter((e) => e.event === 'phase-commit');
    expect(seals.length).toBe(2);
    expect(new Set(seals.map((e) => e.sha as string)).size).toBe(2);
    expect(h.log.count('commit')).toBe(2);

    // ── each seal was made in its own worktree: the second tree's red commit
    // is not the first tree's carried over.
    const trees = h.log.of('commit').map((e) => (e.detail as string).split(':')[0]);
    expect(new Set(trees).size).toBe(2);
  });
});

describe('phase commit (D13) — a resume with nothing left to run', () => {
  test('phases ending on the sealed red fail the node instead of remaking the seal', async () => {
    // The retry lands downstream of the seal (a failing smoke) on a phase list
    // whose last phase is the red one. There is no prompt to send that would
    // not re-enter red over a tree that already sealed it, so the attempt is a
    // typed plan error — loud and named — never a second seal and never an
    // empty attempt that burns the budget on an unchanged tree.
    const h = makeHarness({
      changedByNode: { n5: ['test/widget.test.ts'] },
      waitScript: () => stop({ filesTouched: ['test/widget.test.ts'] }),
      execScript: (argv) =>
        argv[0] === 'runtests'
          ? { output: 'FAIL widget: not implemented', exitCode: 1 }
          : { output: 'smoke: boom', exitCode: 1 },
    });
    const summary = await runPlan(
      plan([
        makeNode({
          id: 'n5',
          work: { test: 'runtests', phases: [{ phase: 'red', prompt: RED_PROMPT }] },
          accept: { smoke: 'smoke' },
          policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
        }),
      ]),
      h.deps,
      OPTS,
    );
    expect(summary.failed).toEqual(['n5']);

    // ── one red phase, one seal: attempt 2 sent no prompt at all.
    expect(buildSends(h, 'n5')).toEqual([RED_PROMPT]);
    expect(h.journal.filter((e) => e.event === 'phase-commit').length).toBe(1);
    expect(h.log.count('commit')).toBe(1);

    // ── the failure names the node and what the ladder had left, so nobody
    // debugs a node that simply stopped prompting.
    const journalled = h.journal.find((e) => e.event === 'verdict' && e.node === 'n5');
    expect(journalled?.status).toBe('failed');
    expect(journalled?.detail as string).toContain('n5');
    expect(journalled?.detail as string).toContain('no phase left to run');
  });
});
