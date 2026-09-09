// ledger: D13 — the red phase is its own commit.
//
// A phased node's RED state must exist in `node/<id>` history. The moment the
// RED gate passes, the red phase's files are scoped-staged and sealed as their
// own commit on the detached HEAD — before the impl prompt is sent — and the
// settle commit stacks on it: base → red → verified. In-memory seams
// (harness.ts); the subject is the loop's phase ladder. Real git history
// (parentage, trees) is proven in test/e2e/phase-commit.test.ts.
//
// The seal calls a new IsolateSeam method, `commit(cwd, message)` — a commit on
// the detached HEAD that moves NO branch (commitBranch force-points one, which
// would publish unverified work). The harness records it as:
//   • EventLog kind 'commit', one per seal, in call order;
//   • InMemoryGit.commitMessages keyed by the returned sha (a detached commit
//     has no branch to key on).
import { describe, expect, test } from 'bun:test';
import type { Plan } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Event, type Harness, makeHarness, makeNode, stop } from './harness.ts';

const OPTS = { repoRoot: '/repo', defaultTimeoutMs: 1000 };

function plan(nodes: Plan['nodes']): Plan {
  return { goal: 'g', source: 'garden.tend.html', nodes };
}

// Sequence number of the first matching event; -1 when it never happened (so
// every ordering assertion below fails on an absent event, never passes).
function at(h: Harness, pred: (e: Event) => boolean): number {
  return h.log.events.find(pred)?.at ?? -1;
}

// The phase test command: exits non-zero the first time (RED must fail) and
// zero the second (GREEN must pass) — one honest red/green cycle per node.
function redThenGreen(): (argv: readonly string[]) => { output: string; exitCode: number } {
  let runs = 0;
  return (argv) => {
    if (argv[0] !== 'runtests') return { output: '', exitCode: 0 };
    runs += 1;
    return runs === 1
      ? { output: 'FAIL widget: not implemented', exitCode: 1 }
      : { output: 'ok 1 widget', exitCode: 0 };
  };
}

describe('phase commit (D13) — the red phase is sealed before impl is prompted', () => {
  test('RED gate passes → scoped-staged red commit, phase trailer, journal, no branch moved', async () => {
    const h = makeHarness({
      // The tree holds only the failing test when the red gate runs.
      changedByNode: { n1: ['test/widget.test.ts'] },
      waitScript: (_ctx, waitIndex) =>
        stop({ filesTouched: waitIndex === 0 ? ['test/widget.test.ts'] : ['src/widget.ts'] }),
      execScript: redThenGreen(),
    });
    const summary = await runPlan(
      plan([
        makeNode({
          id: 'n1',
          work: {
            test: 'runtests',
            phases: [
              { phase: 'red', prompt: 'write the failing test' },
              { phase: 'impl', prompt: 'make it pass' },
              { phase: 'green', prompt: 'run the suite' },
            ],
          },
          policy: { maxAttempts: 1, onDead: 'resume', reauditWhen: ['compacted'] },
        }),
      ]),
      h.deps,
      OPTS,
    );
    expect(summary.closed).toEqual(['n1']);

    // ── the seal is journalled with the phase, its sha and the files it staged
    const sealed = h.journal.find((e) => e.event === 'phase-commit');
    expect(sealed?.node).toBe('n1');
    expect(sealed?.phase).toBe('red');
    expect(sealed?.files).toEqual(['test/widget.test.ts']);
    const redSha = sealed?.sha;
    expect(typeof redSha).toBe('string');
    expect(redSha as string).not.toBe('');
    expect(h.journal.filter((e) => e.event === 'phase-commit').length).toBe(1);

    // ── the message: subject names the node and the phase, the body names the
    // test command that went red, and the trailer is the last line.
    const message = h.git.commitMessages.get(redSha as string) ?? '';
    const lines = message.split('\n');
    expect(lines[0]).toBe('pleach: n1 red phase');
    expect(message).toContain('runtests');
    expect(lines.filter((l) => l.trim() !== '').at(-1)).toBe('pleach-phase: red');

    // ── the moment: after the red gate ran, before the impl prompt was sent.
    const redPrompt = at(
      h,
      (e) => e.kind === 'send' && e.detail === 'build:write the failing test',
    );
    const redGate = at(h, (e) => e.kind === 'exec' && e.detail === 'runtests');
    // Exactly the red file, staged in the node's worktree — the harness records
    // stage as `<cwd>:<files>`, so this pins the scoped set, not `add -A`.
    const sealStage = at(
      h,
      (e) => e.kind === 'stage' && /^\/wt\/n1\/\d+:test\/widget\.test\.ts$/.test(e.detail ?? ''),
    );
    const seal = at(h, (e) => e.kind === 'commit');
    const implPrompt = at(h, (e) => e.kind === 'send' && e.detail === 'build:make it pass');
    const settle = at(h, (e) => e.kind === 'commitBranch' && e.node === 'node/n1');
    expect(redPrompt).toBeGreaterThanOrEqual(0);
    expect(redGate).toBeGreaterThan(redPrompt);
    expect(sealStage).toBeGreaterThan(redGate);
    expect(seal).toBeGreaterThan(sealStage);
    expect(implPrompt).toBeGreaterThan(seal);
    expect(settle).toBeGreaterThan(implPrompt);
    expect(h.log.count('commit')).toBe(1);

    // ── the seal publishes nothing: no ref points at the red commit, and the
    // one branch move in the run is the settle commit.
    expect([...h.git.refs.values()]).not.toContain(redSha as string);
    expect(h.log.count('commitBranch')).toBe(1);

    // ── the settle commit stacks on the red one: same (single) worktree, made
    // after the seal on the HEAD the seal moved. node/<id> therefore reads
    // base → red → verified (the git-history proof is the e2e sibling).
    expect(h.log.count('isolate', 'n1')).toBe(1);
    const closed = h.journal.find((e) => e.event === 'closed' && e.node === 'n1');
    expect(closed?.sha).toBe(h.git.refs.get('node/n1') as string);
    expect(closed?.sha).not.toBe(redSha);
  });

  test('the seal is keyed to the RED gate, not to the first phase', async () => {
    const h = makeHarness({
      changedByNode: { n2: ['src/mod.ts', 'test/mod.test.ts'] },
      waitScript: (_ctx, waitIndex) =>
        stop({ filesTouched: waitIndex === 1 ? ['test/mod.test.ts'] : ['src/mod.ts'] }),
      execScript: redThenGreen(),
    });
    const summary = await runPlan(
      plan([
        makeNode({
          id: 'n2',
          work: {
            test: 'runtests',
            phases: [
              { phase: 'impl', prompt: 'scaffold the module' },
              { phase: 'red', prompt: 'write the failing test' },
              { phase: 'impl', prompt: 'make it pass' },
              { phase: 'green', prompt: 'run the suite' },
            ],
          },
          policy: { maxAttempts: 1, onDead: 'resume', reauditWhen: ['compacted'] },
        }),
      ]),
      h.deps,
      OPTS,
    );
    expect(summary.closed).toEqual(['n2']);

    const sealed = h.journal.find((e) => e.event === 'phase-commit');
    expect(sealed?.phase).toBe('red');
    // Everything the tree holds when red goes green is sealed (filesTouched ∪
    // changedFiles) — including what the earlier impl phase left behind.
    expect([...((sealed?.files ?? []) as string[])].sort()).toEqual([
      'src/mod.ts',
      'test/mod.test.ts',
    ]);

    const scaffoldPrompt = at(
      h,
      (e) => e.kind === 'send' && e.detail === 'build:scaffold the module',
    );
    const redGate = at(h, (e) => e.kind === 'exec' && e.detail === 'runtests');
    const seal = at(h, (e) => e.kind === 'commit');
    const implPrompt = at(h, (e) => e.kind === 'send' && e.detail === 'build:make it pass');
    expect(scaffoldPrompt).toBeGreaterThanOrEqual(0);
    expect(redGate).toBeGreaterThan(scaffoldPrompt);
    expect(seal).toBeGreaterThan(redGate);
    expect(implPrompt).toBeGreaterThan(seal);
    expect(h.log.count('commit')).toBe(1);
  });

  test('work without a test phase seals nothing — the only commit is the settle', async () => {
    const h = makeHarness();
    const summary = await runPlan(
      plan([makeNode({ id: 'p1' }), makeNode({ id: 'c1', work: { command: 'do-it' } })]),
      h.deps,
      OPTS,
    );
    expect(summary.closed.sort()).toEqual(['c1', 'p1']);
    expect(h.journal.some((e) => e.event === 'phase-commit')).toBe(false);
    expect(h.log.count('commit')).toBe(0);
    expect(h.log.count('commitBranch')).toBe(2);
  });
});
