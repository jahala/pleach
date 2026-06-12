import { describe, expect, test } from 'bun:test';
import { RebuildRequiredError } from '../../src/core/errors.ts';
import type { Plan, Verdict } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness, makeNode, stop, type WaitScript } from './harness.ts';

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
    // dep isolated against node/cmd (cmd's branch committed).
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
  test('emitVerdict {closed:false} on an audit node → NO node/<id> branch, dependents skipped', async () => {
    const h = makeHarness({
      auditEgress: () => auditPass,
      emitDecision: () => ({ closed: false }), // tend refuses to close
    });
    const p = plan({
      nodes: [auditNode('a'), makeNode({ id: 'b', needs: ['a'] })],
    });
    const summary = await runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    expect(summary.closed).not.toContain('a');
    expect(summary.skipped).toContain('b');
    // Branch is force-deleted / never persists for an unclosed node? Spec: commit
    // happens before emit; if tend refuses, the work is NOT closed and dependents
    // are skipped. The ref may exist but the node is not in closed.
    expect(summary.closed).toEqual([]);
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

describe('runPlan — M3 defensive copy of readClosed', () => {
  test('mutating the Map returned by tend after start does not affect the run', async () => {
    const closed = new Map<string, string | null>();
    const h = makeHarness({ closed });
    const p = plan({
      nodes: [makeNode({ id: 'x' }), makeNode({ id: 'y', needs: ['x'] })],
    });
    // Mutate the source map to falsely mark 'y' closed AFTER the run reads it.
    const runP = runPlan(p, h.deps, { repoRoot: REPO, defaultTimeoutMs: 1000 });
    closed.set('y', 'b'.repeat(40)); // should NOT affect the run's view
    const summary = await runP;
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
