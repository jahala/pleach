import { describe, expect, test } from 'bun:test';
import { RebuildRequiredError } from '../../src/core/errors.ts';
import type { Plan, Verdict } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, makeHarness, makeNode, stop, type WaitScript } from './harness.ts';

// spec: §6 + ledger A1,B1,B2,C2,M3 + blocked + ordering. In-memory seams; the
// subject is run-plan's scheduling, close paths, and commit/dispose ordering.

const REPO = '/repo';
const SRC = 'garden.tend.html';

function plan(over: Partial<Plan> & { nodes: Plan['nodes'] }): Plan {
  return { goal: 'g', source: SRC, ...over };
}

const auditPass = '```tend-audit-result\n{"verdicts":[{"check":"c","verdict":"pass"}]}\n```';

function auditNode(id: string, needs: string[] = []) {
  return makeNode({
    id,
    needs,
    accept: { audit: { command: `audit ${id}`, provider: 'codex' } },
  });
}

describe('runPlan — §6 diamond wave order + semaphore', () => {
  test('A→{B,C}→D: wave order respected; concurrency never exceeds the cap', async () => {
    const h = makeHarness();
    const p = plan({
      maxConcurrency: 2,
      nodes: [
        makeNode({ id: 'A' }),
        makeNode({ id: 'B', needs: ['A'] }),
        makeNode({ id: 'C', needs: ['A'] }),
        makeNode({ id: 'D', needs: ['B', 'C'] }),
      ],
    });
    const summary = await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    expect(summary.closed.sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(h.maxConcurrentWorkers).toBeLessThanOrEqual(2);
    // A's branch committed before B and C isolate (they need A).
    expect(h.log.first('commitBranch', 'node/A')).toBeLessThan(h.log.first('isolate', 'B'));
    expect(h.log.first('commitBranch', 'node/A')).toBeLessThan(h.log.first('isolate', 'C'));
  });

  test('semaphore caps concurrent workers at maxConcurrency for a wide fan-out', async () => {
    // Five independent nodes, cap 2 — the harness counts live spawns and tracks
    // the peak. The wait microtask yields between spawn and kill, so multiple
    // workers are genuinely live concurrently when the cap allows.
    const h = makeHarness();
    const p = plan({
      maxConcurrency: 2,
      nodes: ['n1', 'n2', 'n3', 'n4', 'n5'].map((id) => makeNode({ id })),
    });
    const summary = await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    expect(summary.closed.length).toBe(5);
    expect(h.maxConcurrentWorkers).toBeLessThanOrEqual(2);
  });
});

describe('runPlan — A1 dual close', () => {
  test('non-audit node closes on done (conductor decides); dependent runs', async () => {
    const h = makeHarness();
    const p = plan({
      nodes: [
        makeNode({ id: 'cmd', work: { command: 'echo hi' } }),
        makeNode({ id: 'dep', needs: ['cmd'], work: { prompt: 'p' } }),
      ],
    });
    const summary = await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    expect(summary.closed.sort()).toEqual(['cmd', 'dep']);
    // dep isolated against the recorded commit SHA of cmd (not the branch string 'node/cmd').
    expect(h.git.refs.has('node/cmd')).toBe(true);
    expect(h.log.first('isolate', 'dep')).toBeGreaterThan(h.log.first('commitBranch', 'node/cmd'));
  });

  test('audit node closes only when emitVerdict returns {closed:true}', async () => {
    const h = makeHarness({
      auditEgress: () => auditPass,
      emitDecision: () => ({ closed: true }),
    });
    const p = plan({ nodes: [auditNode('a')] });
    const summary = await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    expect(summary.closed).toEqual(['a']);
  });
});

describe('runPlan — §6 commit-on-verified', () => {
  test('emitVerdict {closed:false} on an audit node → partial (not failed); dependents skipped', async () => {
    const h = makeHarness({
      auditEgress: () => auditPass,
      emitDecision: () => ({ closed: false }), // tend refuses to close
    });
    const p = plan({
      nodes: [auditNode('a'), makeNode({ id: 'b', needs: ['a'] })],
    });
    const summary = await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    // Commit precedes emit (B2), but tend's refusal means 'a' is NOT closed; its
    // dependent 'b' never becomes ready and is reported skipped.
    expect(summary.closed).not.toContain('a');
    expect(summary.skipped).toContain('b');
    expect(summary.closed).toEqual([]);
    // 'b' must never have isolated (its only dep never closed).
    expect(h.log.count('isolate', 'b')).toBe(0);
    // The work LANDED (committed to node/a) and the audit PASSED — tend just
    // won't verify it. That is 'partial', NOT 'failed': a caller that retries
    // failed nodes must not rebuild a node whose branch is already published & good.
    expect(summary.partial).toContain('a');
    expect(summary.failed).not.toContain('a');
    // The journal records it honestly — a done verdict plus a not-closed event,
    // never a failure — so the run is explainable from the journal alone.
    const aVerdict = h.journal.find((e) => e.event === 'verdict' && e.node === 'a');
    expect(aVerdict?.status).toBe('done');
    expect(h.journal.some((e) => e.event === 'not-closed' && e.node === 'a')).toBe(true);
  });
});

describe('runPlan — B2 commit before emit; diffRef carries the sha', () => {
  test('closing audit node: commitBranch precedes emitVerdict; verdict.diffRef === sha', async () => {
    let emittedVerdict: Verdict | null = null;
    const h = makeHarness({
      auditEgress: () => auditPass,
      emitDecision: (v) => {
        emittedVerdict = v;
        return { closed: true };
      },
    });
    const p = plan({ nodes: [auditNode('a')] });
    await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    expect(h.log.first('commitBranch', 'node/a')).toBeLessThan(h.log.first('emitVerdict', 'a'));
    const sha = h.git.refs.get('node/a');
    expect(emittedVerdict).not.toBeNull();
    expect((emittedVerdict as unknown as Verdict).evidence.diffRef).toBe(sha as string);
  });
});

describe('runPlan — B1 startup reconciliation', () => {
  test('closed dep with missing branch but recorded sha → isolate receives the sha', async () => {
    const recordedSha = 'a'.repeat(40);
    const h = makeHarness({
      closed: new Map([['dep', recordedSha]]),
      refs: { [recordedSha]: recordedSha }, // refSha resolves the bare sha
    });
    const p = plan({
      nodes: [
        makeNode({ id: 'dep' }), // already closed — seeded
        makeNode({ id: 'child', needs: ['dep'], work: { prompt: 'p' } }),
      ],
    });
    const summary = await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    // child isolates against the recorded sha (node/dep branch absent).
    const childIso = h.log.of('isolate').find((e) => e.node === 'child');
    expect(childIso?.detail).toContain(recordedSha);
    expect(summary.closed).toContain('child');
  });

  test('closed dep with neither branch nor recorded sha → RebuildRequiredError before any node runs', async () => {
    const h = makeHarness({
      closed: new Map([['dep', null]]), // legacy: no sha, and no node/dep ref
    });
    const p = plan({
      nodes: [
        makeNode({ id: 'dep' }),
        makeNode({ id: 'child', needs: ['dep'], work: { prompt: 'p' } }),
      ],
    });
    let err: unknown;
    try {
      await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RebuildRequiredError);
    expect((err as RebuildRequiredError).nodeId).toBe('dep');
    // halt before any node runs
    expect(h.log.count('isolate')).toBe(0);
  });
});

describe('runPlan — blocked', () => {
  test('input → status blocked, in RunSummary.blocked, no retry, dependents skipped', async () => {
    const script: WaitScript = (ctx) =>
      ctx.node === 'a' && ctx.role === 'build'
        ? stop({ reason: 'input', message: 'need a key' })
        : stop();
    const h = makeHarness({ waitScript: script });
    const p = plan({
      nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b', needs: ['a'] })],
    });
    const summary = await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    expect(summary.blocked).toContain('a');
    expect(summary.skipped).toContain('b');
    const v = h.emitted.find((e) => e.node === 'a');
    expect(v?.status).toBe('blocked');
    expect(v?.evidence.blockedReason).toBe('need a key');
    expect(h.log.count('spawn:build', 'a')).toBe(1); // no retry
  });
});

describe('runPlan — C4 audit re-spawn through the scheduler', () => {
  test('garbage egress then good → builder spawned once, auditor twice, node closes', async () => {
    let buildSpawns = 0;
    let auditSpawns = 0;
    const script: WaitScript = (ctx) => {
      if (ctx.role === 'build') {
        buildSpawns += 1;
        return stop();
      }
      auditSpawns += 1;
      return auditSpawns === 1
        ? stop({ finalMessage: 'garbage' })
        : stop({ finalMessage: auditPass });
    };
    const h = makeHarness({ waitScript: script, emitDecision: () => ({ closed: true }) });
    const p = plan({ nodes: [auditNode('a')] });
    const summary = await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    expect(summary.closed).toContain('a');
    expect(buildSpawns).toBe(1);
    expect(auditSpawns).toBe(2);
  });
});

describe('runPlan — failure is diagnosable from the journal alone', () => {
  test('a failed node records its gate + attempts in the verdict event', async () => {
    // Smoke fails forever → node failed with a gate. The journal (not the
    // disposed worktree) must explain why.
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
    const verdict = h.journal.find((e) => e.event === 'verdict' && e.node === 'n');
    expect(verdict?.status).toBe('failed');
    expect(verdict?.attempts).toBe(1);
    expect((verdict?.gate as { ran: string } | undefined)?.ran).toContain('false');
  });
});

describe('runPlan — M3 defensive copy of readClosed', () => {
  test('mutating the Map returned by tend after the loop reads it does not affect the run', async () => {
    const closed = new Map<string, string | null>();
    const h = makeHarness({ closed });
    // Mutate the source map from inside the FIRST isolate — unambiguously after
    // the loop has done `new Map(await readClosed())`. A non-defensive loop that
    // held the live reference would now see 'y' as pre-closed and skip it.
    const realIsolate = h.deps.isolate.isolate;
    let mutated = false;
    h.deps.isolate.isolate = async (node, baseRefs) => {
      if (!mutated) {
        mutated = true;
        closed.set('y', 'b'.repeat(40));
      }
      return realIsolate(node, baseRefs);
    };
    const p = plan({
      nodes: [makeNode({ id: 'x' }), makeNode({ id: 'y', needs: ['x'] })],
    });
    const summary = await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    // y must still be BUILT (closed by the run), not skipped as pre-closed.
    expect(h.log.count('isolate', 'y')).toBe(1);
    expect(summary.closed).toContain('y');
  });
});

describe('runPlan — ordering invariant: dispose before dependent isolate', () => {
  test("a dependent's isolate never precedes its dep's dispose", async () => {
    const h = makeHarness();
    const p = plan({
      nodes: [makeNode({ id: 'p' }), makeNode({ id: 'c', needs: ['p'], work: { prompt: 'x' } })],
    });
    await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    expect(h.log.first('dispose', 'p')).toBeLessThan(h.log.first('isolate', 'c'));
  });
});

describe('runPlan — seed closure', () => {
  test('a closed integration node seeds its transitive ancestors as closed', async () => {
    // integration 'I' needs 'S'; only 'I' is recorded closed → 'S' seeded closed.
    const recordedSha = 'c'.repeat(40);
    const h = makeHarness({
      closed: new Map([['I', recordedSha]]),
      refs: { 'node/I': recordedSha, [recordedSha]: recordedSha },
    });
    const p = plan({
      nodes: [
        makeNode({ id: 'S' }),
        makeNode({ id: 'I', needs: ['S'] }),
        makeNode({ id: 'next', needs: ['I'], work: { prompt: 'p' } }),
      ],
    });
    const summary = await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    // S and I are pre-closed (not re-run); only 'next' runs.
    expect(h.log.count('isolate', 'S')).toBe(0);
    expect(h.log.count('isolate', 'I')).toBe(0);
    expect(h.log.count('isolate', 'next')).toBe(1);
    expect(summary.closed).toContain('next');
  });
});

describe('runPlan — pre-commit marker safety', () => {
  test('markers written after staging (auditor droppings) fail the node, no commit', async () => {
    // The auditor writes markers into the shared cwd; the pre-commit scan must
    // catch them and fail the node before commitBranch.
    const h = makeHarness({
      auditEgress: () => auditPass,
      emitDecision: () => ({ closed: true }),
    });
    const p = plan({ nodes: [auditNode('a')] });
    // After the in-loop marker gate passes, inject a marker before commit.
    let scans = 0;
    const realScan = h.deps.isolate.scanMarkers;
    h.deps.isolate.scanMarkers = async (cwd: string) => {
      scans += 1;
      // first scan (in-node gate) clean; second scan (pre-commit) dirty.
      return scans >= 2 ? ['poisoned.ts'] : realScan(cwd);
    };
    const summary = await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    expect(summary.failed).toContain('a');
    expect(h.git.refs.has('node/a')).toBe(false);
  });
});

describe('runPlan — lock + journal', () => {
  test('acquires the lock and releases it; journals run-start and run-end', async () => {
    const h = makeHarness();
    const p = plan({ nodes: [makeNode({ id: 'a' })] });
    await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    expect(h.log.count('lock.acquire')).toBe(1);
    expect(h.log.count('lock.release')).toBe(1);
    const evs = h.journal.map((e) => e.event);
    expect(evs).toContain('run-start');
    expect(evs).toContain('run-end');
  });
});

// ── dispose failure safety (audit finding #37) ───────────────────────────────
// Node promises must NEVER reject. A dispose() throwing IsolateCatastrophicError
// on a done node (after commitBranch + emitVerdict) must be journaled, not fatal.
describe('runPlan — dispose failure is journaled, not run-fatal', () => {
  test('dispose throw on a closed node is journaled; summary.closed contains the node', async () => {
    const h = makeHarness({ disposeThrows: new Set(['A']) });
    const p = plan({ nodes: [makeNode({ id: 'A' })] });
    const summary = await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    expect(summary.closed).toContain('A');
    expect(h.journal.some((e) => e.event === 'dispose-failed' && e.node === 'A')).toBe(true);
  });
});

// ── C5 SHA pinning (audit #41) ────────────────────────────────────────────────
// The conductor records the *commit SHA* of each node/<id> it creates and must
// verify the recorded SHA before use. Branch pointers are mutable; SHAs are not.
describe('runPlan — C5 SHA pinning', () => {
  test('WITHIN-RUN: B isolates from the recorded commit SHA of A, not the branch string', async () => {
    // A→B: after A commits to node/A, settle must store the SHA (not 'node/A')
    // in baseRefForClosed so that B's isolate receives an immutable ref.
    const h = makeHarness();
    const p = plan({
      nodes: [makeNode({ id: 'A' }), makeNode({ id: 'B', needs: ['A'] })],
    });
    await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    // The SHA that commitBranch assigned to node/A.
    const committedSha = h.git.refs.get('node/A');
    expect(committedSha).toBeDefined();
    // B's isolate event must list the committed SHA, not the branch name.
    const bIso = h.log.of('isolate').find((e) => e.node === 'B');
    expect(bIso?.detail).toContain(committedSha);
    expect(bIso?.detail).not.toContain('node/A');
  });

  test('STARTUP: branch moved off recorded SHA → RebuildRequiredError before any node runs', async () => {
    // readClosed says A was verified at recordedSha, but node/A now points
    // to a different SHA → the ref was force-moved (worker attack or external push).
    // The loop must detect the mismatch and throw RebuildRequiredError.
    const recordedSha = 'a'.repeat(40);
    const differentSha = 'b'.repeat(40);
    const h = makeHarness({
      closed: new Map([['A', recordedSha]]),
      refs: {
        'node/A': differentSha, // branch pointer moved off the recorded SHA
      },
    });
    const p = plan({
      nodes: [makeNode({ id: 'A' }), makeNode({ id: 'B', needs: ['A'] })],
    });
    let err: unknown;
    try {
      await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RebuildRequiredError);
    expect((err as RebuildRequiredError).nodeId).toBe('A');
    // Halt before any node runs.
    expect(h.log.count('isolate')).toBe(0);
  });
});

// ── lead review: the closed-before-dispose window ────────────────────────────
// ledger: ordering invariant under CONCURRENCY. closed.set(A) must not become
// visible to the scheduler while A's worktree is still being disposed — another
// node's resolution can wake the scheduler inside that window and a dependent
// would isolate against a live tree.
test('lead: dependent never isolates inside its dep dispose window (cross-node wake)', async () => {
  let h: Harness | undefined;
  const until = async (cond: () => boolean, ms: number): Promise<void> => {
    const t0 = Date.now();
    while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
  };
  const harness = makeHarness({
    // Hold A's dispose open until C (wrongly) isolates, or 300ms.
    disposeDelay: async (nodeId) => {
      if (nodeId !== 'a') return;
      await until(() => (h as Harness).log.count('isolate', 'c') > 0, 300);
    },
    // B finishes only after A has ENTERED dispose — its resolution is the
    // scheduler wake that exposes the window.
    waitScript: async (ctx) => {
      if (ctx.node === 'b') {
        await until(() => (h as Harness).log.count('dispose-start', 'a') > 0, 1000);
      }
      return stop();
    },
  });
  h = harness;

  const p = plan({
    nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b' }), makeNode({ id: 'c', needs: ['a'] })],
  });
  await runPlan(p, harness.deps, { repoRoot: REPO, maxConcurrency: 2 });

  const isoC = harness.log.first('isolate', 'c');
  const disposeA = harness.log.first('dispose', 'a');
  expect(isoC).toBeGreaterThan(-1);
  expect(disposeA).toBeGreaterThan(-1);
  expect(isoC).toBeGreaterThan(disposeA);
});
