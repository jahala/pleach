// issue #116 — a land conflict pins the node and the next run rebuilds it on
// the landed stack. loop tests over the in-memory seams: the scheduler's
// invalidation, the isolation base, the first prompt, and the ref lifecycle.
//
// The rebuild is the lead's rejected-cherry-pick alternative: the node is
// re-dispatched on the landed stack with its own verified branch merged on top
// (markers kept), so a worker integrates the sibling's change and the whole
// gate ladder judges the result. The journal says `land-rebuild { node, onto }`
// when the pin is consumed and `land-rebuild-done { node }` when the rebuilt
// node publishes; the ref is kept on any other verdict.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import type { Receipt } from '../../src/core/receipt.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, makeHarness } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };
const SOURCE = 'docs/tend2/land-rebuild.tend2.html';

// The stack commit the conflict was pinned at (the target tip plus the sinks
// landed before the conflicting one), and the node's own prior verified sha.
const STACK = 'ab12'.repeat(10);
const OLD = 'cd34'.repeat(10);

// The baseRefs each isolate was asked for, in order — the whole claim about
// where a rebuilt tree is checked out from and what merges onto it.
function bases(h: Harness): string[][] {
  const seen: string[][] = [];
  const inner = h.deps.isolate.isolate;
  h.deps.isolate.isolate = (node, baseRefs) => {
    seen.push([...baseRefs]);
    return inner(node, baseRefs);
  };
  return seen;
}

function prompts(h: Harness, node: string): string[] {
  return h.log
    .of('send')
    .filter((e) => e.node === node && (e.detail ?? '').startsWith('build:'))
    .map((e) => (e.detail as string).slice('build:'.length));
}

function receiptOf(h: Harness, node: string): Receipt {
  const receipt = h.receipts.get(node);
  if (receipt === undefined) throw new TypeError(`node '${node}' wrote no receipt`);
  return receipt;
}

function rebuildLines(h: Harness): Record<string, unknown>[] {
  return h.journal.filter((e) => e.event === 'land-rebuild');
}

function rebuildDoneLines(h: Harness): Record<string, unknown>[] {
  return h.journal.filter((e) => e.event === 'land-rebuild-done');
}

describe('a land conflict is rebuilt on the landed stack (issue #116)', () => {
  test('the pinned node re-dispatches on the stack, its own branch merged last', async () => {
    const h = makeHarness({
      closed: new Map([['b', OLD]]),
      refs: { 'refs/pleach/rebuild/b': STACK, 'node/b': OLD },
      conflicts: { b: ['shared.txt'] },
      changedByNode: { b: ['shared.txt'] },
    });
    const seen = bases(h);

    const summary = await runPlan(
      PlanSchema.parse({
        goal: 'g',
        source: SOURCE,
        nodes: [{ id: 'b', work: { prompt: 'build b' } }],
      }),
      h.deps,
      OPTS,
    );

    expect(summary.closed).toEqual(['b']);
    // baseRefs[0] is the stack; the node's own verified branch merges on top
    // (a worker node integrates its own prior work against the sibling's).
    expect(seen).toEqual([[STACK, 'node/b']]);

    // The pin is consumed and cleared on publish.
    expect(rebuildLines(h)).toHaveLength(1);
    expect(rebuildLines(h)[0]).toMatchObject({ node: 'b', onto: STACK });
    expect(rebuildDoneLines(h)).toHaveLength(1);
    expect(rebuildDoneLines(h)[0]).toMatchObject({ node: 'b' });
    expect(h.git.refs.has('refs/pleach/rebuild/b')).toBe(false);

    // The close's receipt records the provenance.
    expect(receiptOf(h, 'b').facts.base).toEqual({ kind: 'land-rebuild', sha: STACK });

    // The first prompt tells the worker what it is standing in.
    const first = prompts(h, 'b')[0] ?? '';
    expect(first).toContain('build b');
    expect(first).toContain('conflicts with work that has landed since');
    expect(first).toContain('shared.txt');
  });

  test('a rebuilt node whose worker leaves the markers fails the marker gate and keeps the ref', async () => {
    const h = makeHarness({
      closed: new Map([['b', OLD]]),
      refs: { 'refs/pleach/rebuild/b': STACK, 'node/b': OLD },
      conflicts: { b: ['shared.txt'] },
      changedByNode: { b: ['shared.txt'] },
      markersByNode: { b: ['shared.txt'] },
    });

    const summary = await runPlan(
      PlanSchema.parse({
        goal: 'g',
        source: SOURCE,
        nodes: [{ id: 'b', work: { prompt: 'build b' }, policy: { maxAttempts: 1 } }],
      }),
      h.deps,
      OPTS,
    );

    expect(summary.failed).toEqual(['b']);
    expect(h.emitted.find((v) => v.node === 'b')?.evidence.gate).toEqual({
      ran: 'marker',
      exitCode: -1,
    });
    // On any other verdict the ref is kept, so the next run tries again.
    expect(rebuildDoneLines(h)).toHaveLength(0);
    expect(h.git.refs.get('refs/pleach/rebuild/b')).toBe(STACK);
    // The failed close still records what it stood on.
    expect(receiptOf(h, 'b').facts.base).toEqual({ kind: 'land-rebuild', sha: STACK });
  });

  test('a {command} sink pinned by a conflict reruns its command on the stack, no own branch', async () => {
    const h = makeHarness({
      closed: new Map([['b', OLD]]),
      refs: { 'refs/pleach/rebuild/b': STACK },
      changedByNode: { b: ['b.txt'] },
    });
    const seen = bases(h);

    const summary = await runPlan(
      PlanSchema.parse({
        goal: 'g',
        source: SOURCE,
        nodes: [{ id: 'b', work: { command: 'bash -lc "echo b > b.txt"' } }],
      }),
      h.deps,
      OPTS,
    );

    expect(summary.closed).toEqual(['b']);
    // A {command} node does not merge its old branch: it reruns on the stack.
    expect(seen).toEqual([[STACK]]);
    // The command actually ran (the exec seam saw it).
    expect(h.log.of('exec').some((e) => (e.detail ?? '').includes('bash'))).toBe(true);
    expect(rebuildDoneLines(h)).toHaveLength(1);
    expect(h.git.refs.has('refs/pleach/rebuild/b')).toBe(false);
    expect(receiptOf(h, 'b').facts.base).toEqual({ kind: 'land-rebuild', sha: STACK });
  });

  test('--fresh still builds on the stack, but skips merging the old branch', async () => {
    const h = makeHarness({
      closed: new Map([['b', OLD]]),
      refs: { 'refs/pleach/rebuild/b': STACK, 'node/b': OLD },
      changedByNode: { b: ['shared.txt'] },
    });
    const seen = bases(h);

    await runPlan(
      PlanSchema.parse({
        goal: 'g',
        source: SOURCE,
        nodes: [{ id: 'b', work: { prompt: 'build b' } }],
      }),
      h.deps,
      { ...OPTS, fresh: true },
    );

    expect(seen).toEqual([[STACK]]);
  });
});
