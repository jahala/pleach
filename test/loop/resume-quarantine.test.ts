// ledger: D17 — a re-run resumes from the quarantined tree. An aborted or
// failed node hands its work back on `quarantine/<id>` (D11, D16); today the
// next `pleach run` isolates that node from its dependencies alone, so the
// tree the worker actually wrote is preserved for a human and rebuilt from
// nothing by the conductor (jahala/pleach#91).
//
// Resuming is the one with rules. A quarantined tree was NEVER gated — no
// marker scan, no hygiene, no smoke, no audit ran over it — so the only thing
// trusted about it is that it is the worker's own work. The resumed attempt
// re-runs the whole ladder, and the close records `facts.base` inside the
// sealed envelope, so a close that stood on a quarantine stays distinguishable
// from one that built its own tree forever (the umbrella's receipt predicate
// reads it). The quarantine is the CHECKOUT base — baseRefs[0] — and the
// dependencies merge on top of it exactly as they do for a fresh isolation.
// `--fresh` opts out and leaves today's behaviour untouched.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { canonicalJson, type Receipt, rehash } from '../../src/core/receipt.ts';
import type { RunSummary } from '../../src/loop/deps.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, type HarnessOpts, makeHarness } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };
const SOURCE = 'docs/tend2/nothing-is-lost.tend2.html';
const SMOKE = 'bun test';
const SETUP = 'bun install';
const AUDIT = { command: 'bash git-audit.sh c5', provider: 'codex' };

// The sha `quarantine/x` resolves to — the tree the interrupted attempt left.
const QSHA = 'ab12'.repeat(10);
// A dependency's closed commit, so the merge order is observable.
const ASHA = 'cd34'.repeat(10);

interface Shape {
  // Refs the repo already holds when the run starts.
  refs?: Record<string, string>;
  // The `--fresh` flag: re-isolate, do not resume.
  fresh?: boolean;
  // Conflict markers the resumed tree carries — the gate the quarantine never ran.
  markers?: string[];
  maxAttempts?: number;
}

function nodeSpec(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    work: { prompt: `build ${id}` },
    setup: SETUP,
    accept: { smoke: SMOKE, audit: AUDIT },
    policy: { maxAttempts: 2 },
    ...over,
  };
}

function harnessFor(shape: Shape, extra: HarnessOpts = {}): Harness {
  return makeHarness({
    ...(shape.refs !== undefined ? { refs: shape.refs } : {}),
    ...(shape.markers !== undefined ? { markersByNode: { x: shape.markers } } : {}),
    ...extra,
  });
}

// A single node with no needs: the quarantine is the whole base.
async function runOne(h: Harness, shape: Shape): Promise<RunSummary> {
  return runPlan(
    PlanSchema.parse({
      goal: 'g',
      source: SOURCE,
      nodes: [nodeSpec('x', { policy: { maxAttempts: shape.maxAttempts ?? 2 } })],
    }),
    h.deps,
    { ...OPTS, ...(shape.fresh === true ? { fresh: true } : {}) },
  );
}

// `a` is already verified; `b` needs it and has a quarantine of its own.
async function runDependent(h: Harness, shape: Shape): Promise<RunSummary> {
  return runPlan(
    PlanSchema.parse({
      goal: 'g',
      source: SOURCE,
      nodes: [nodeSpec('a'), nodeSpec('b', { needs: ['a'] })],
    }),
    h.deps,
    { ...OPTS, ...(shape.fresh === true ? { fresh: true } : {}) },
  );
}

// The baseRefs each isolate was asked for, in order — the whole claim about
// where a resumed tree is checked out from and what merges onto it.
function bases(h: Harness): string[][] {
  const seen: string[][] = [];
  const inner = h.deps.isolate.isolate;
  h.deps.isolate.isolate = (node, baseRefs) => {
    seen.push([...baseRefs]);
    return inner(node, baseRefs);
  };
  return seen;
}

// What the builder was actually told, in send order.
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

function gateLadder(h: Harness, node: string): { gate: string; exitCode: number }[] {
  return receiptOf(h, node).facts.gates.map((g) => ({ gate: g.gate, exitCode: g.exitCode }));
}

function resumeLines(h: Harness): Record<string, unknown>[] {
  return h.journal.filter((e) => e.event === 'resumed-from-quarantine');
}

// The sealed facts with the only non-deterministic field flattened: two runs
// that behaved identically produce the same bytes here.
function sealedFacts(h: Harness, node: string): string {
  return canonicalJson({ ...receiptOf(h, node).facts, durationMs: 0 });
}

describe('a re-run resumes from the quarantined tree (D17)', () => {
  test('the quarantine is the checkout base, and the close records it forever', async () => {
    const h = harnessFor({ refs: { 'quarantine/x': QSHA } });
    const seen = bases(h);

    const summary = await runOne(h, {});

    expect(summary.closed).toEqual(['x']);
    // baseRefs[0] IS the checkout base (run-plan's baseRefsFor); a node with no
    // needs resumes from the quarantine alone — it already descends from HEAD.
    expect(seen).toEqual([[QSHA]]);

    // The operator reads the journal, not the source, to learn that a close
    // stood on work an earlier attempt left behind.
    expect(resumeLines(h)).toHaveLength(1);
    expect(resumeLines(h)[0]).toMatchObject({ node: 'x', sha: QSHA });

    // Sealed INSIDE the envelope: what was judged is a fact of the close.
    const receipt = receiptOf(h, 'x');
    expect(receipt.facts.base).toEqual({ kind: 'quarantine', sha: QSHA });
    expect(rehash(receipt)).toBe(true);
  });

  test('the dependencies merge on top of it, in plan order', async () => {
    const h = harnessFor(
      { refs: { 'node/a': ASHA, 'quarantine/b': QSHA } },
      { closed: new Map([['a', ASHA]]) },
    );
    const seen = bases(h);

    const summary = await runDependent(h, {});

    expect(summary.closed).toEqual(['b']);
    expect(summary.alreadyVerified).toEqual(['a']);
    // The quarantine first, the verified dependency merged onto it — a resumed
    // node stands on the same verified work a fresh one would have.
    expect(seen).toEqual([[QSHA, 'node/a']]);
    expect(receiptOf(h, 'b').facts.base).toEqual({ kind: 'quarantine', sha: QSHA });
  });

  test('nothing about the quarantine is trusted: the whole ladder runs', async () => {
    const h = harnessFor({ refs: { 'quarantine/x': QSHA } });

    const summary = await runOne(h, {});

    expect(summary.closed).toEqual(['x']);
    // The gates below are the gates of a RESUMED attempt — without this the
    // assertion would hold for a fresh isolation and prove nothing.
    expect(receiptOf(h, 'x').facts.base).toEqual({ kind: 'quarantine', sha: QSHA });
    // Every gate a fresh isolation runs, run over a tree that was never gated.
    expect(gateLadder(h, 'x')).toEqual([
      { gate: 'setup', exitCode: 0 },
      { gate: 'marker', exitCode: 0 },
      { gate: 'hygiene', exitCode: 0 },
      { gate: 'smoke', exitCode: 0 },
    ]);
    // The cross-provider gate is not a formality a resume may skip.
    expect(h.log.count('spawn:audit', 'x')).toBe(1);
    expect(receiptOf(h, 'x').facts.audit).toEqual([{ check: 'c', verdict: 'pass', reasons: [] }]);
  });

  test('a marker the quarantine carried still fails the node', async () => {
    // The gate that was never run over this tree is the gate that catches it:
    // one attempt, so the failure is the marker scan and nothing else.
    const h = harnessFor({ refs: { 'quarantine/x': QSHA }, markers: ['src/f.ts'] });

    const summary = await runOne(h, { maxAttempts: 1 });

    expect(summary.failed).toEqual(['x']);
    expect(h.emitted.find((v) => v.node === 'x')?.evidence.gate).toEqual({
      ran: 'marker',
      exitCode: -1,
    });
    expect(gateLadder(h, 'x')).toEqual([
      { gate: 'setup', exitCode: 0 },
      { gate: 'marker', exitCode: -1 },
    ]);
    // A resumed close is distinguishable whichever way it went.
    expect(receiptOf(h, 'x').facts.base).toEqual({ kind: 'quarantine', sha: QSHA });
  });

  test('the first prompt carries the interruption as evidence', async () => {
    const h = harnessFor({ refs: { 'quarantine/x': QSHA } });

    await runOne(h, {});

    const first = prompts(h, 'x')[0] ?? '';
    expect(first).toContain('build x'); // the node's own work, not replaced
    expect(first).toContain('resuming work interrupted at');
    expect(first).toContain(QSHA);
  });
});

describe('opting out leaves the first run’s behaviour (D17)', () => {
  test('--fresh re-isolates from the dependencies alone', async () => {
    const h = harnessFor({ refs: { 'quarantine/x': QSHA } });
    const seen = bases(h);

    const summary = await runOne(h, { fresh: true });

    expect(summary.closed).toEqual(['x']);
    expect(seen).toEqual([['HEAD']]); // ROOT_BASE_REF — the quarantine is ignored
    expect(resumeLines(h)).toEqual([]);
    expect(receiptOf(h, 'x').facts.base).toBeUndefined();
    expect(prompts(h, 'x')[0]).toBe('build x'); // no resume evidence
  });

  test('--fresh with dependencies isolates exactly as a first run does', async () => {
    const h = harnessFor(
      { refs: { 'node/a': ASHA, 'quarantine/b': QSHA } },
      { closed: new Map([['a', ASHA]]) },
    );
    const seen = bases(h);

    await runDependent(h, { fresh: true });

    expect(seen).toEqual([['node/a']]);
    expect(receiptOf(h, 'b').facts.base).toBeUndefined();
  });

  test('a node with no quarantine ref is untouched by any of it', async () => {
    const h = harnessFor({});
    const seen = bases(h);

    const summary = await runOne(h, {});

    expect(summary.closed).toEqual(['x']);
    expect(seen).toEqual([['HEAD']]);
    expect(resumeLines(h)).toEqual([]);
    expect(receiptOf(h, 'x').facts.base).toBeUndefined();
  });

  test('--fresh seals byte-identically to a run that never had a quarantine', async () => {
    const fresh = harnessFor({ refs: { 'quarantine/x': QSHA } });
    await runOne(fresh, { fresh: true });

    const plain = harnessFor({});
    await runOne(plain, {});

    expect(sealedFacts(fresh, 'x')).toBe(sealedFacts(plain, 'x'));
  });
});
