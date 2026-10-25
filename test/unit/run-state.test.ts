import { describe, expect, test } from 'bun:test';
import { foldRunState, type NodeStatus } from '../../src/core/run-state.ts';

// The fold is the journal's only reader of run state: pure, total, driven by
// fixture lines exactly as the journal writes them. The latest run-start of a
// source wins, its run-end is recognised by the runId its journalCopy carries,
// and a node's status is pending → running → the verdict's own → closed/partial,
// with never-started nodes skipped once the run ends.

type Line = Record<string, unknown>;

const runStart = (source: string, runId: string): Line => ({
  event: 'run-start',
  source,
  goal: 'g',
  nodes: 3,
  runId,
});
const nodeStart = (node: string): Line => ({ event: 'node-start', node });
const verdict = (node: string, status: string, attempts = 1, durationMs = 10): Line => ({
  event: 'verdict',
  node,
  status,
  attempts,
  durationMs,
});
const attemptStart = (node: string, attempt: number): Line => ({
  event: 'attempt-start',
  node,
  attempt,
});
const phaseStart = (node: string, phase: string, index: number): Line => ({
  event: 'phase-start',
  node,
  phase,
  index,
});
const gateStart = (node: string, gate: string): Line => ({ event: 'gate-start', node, gate });
const gateEnd = (node: string, gate: string): Line => ({ event: 'gate-end', node, gate });
const closed = (node: string): Line => ({ event: 'closed', node, sha: 'abc' });
const notClosed = (node: string): Line => ({ event: 'not-closed', node });
const runEnd = (runId: string, alreadyVerified: string[] = []): Line => ({
  event: 'run-end',
  runId,
  closed: [],
  failed: [],
  alreadyVerified,
  journalCopy: `/runs/${runId}.journal.jsonl`,
});

describe('foldRunState', () => {
  test('no run-start for the source → not started, every node pending', () => {
    const state = foldRunState([runStart('other', 'r2')], 'mine', ['a', 'b']);
    expect(state.started).toBe(false);
    expect(state.ended).toBe(false);
    expect(state.runId).toBeUndefined();
    expect(state.nodes.a?.status).toBe('pending');
    expect(state.nodes.b?.status).toBe('pending');
  });

  test('the latest run-start of the source wins; an earlier run is ignored', () => {
    const lines = [
      runStart('mine', 'r1'),
      nodeStart('a'),
      verdict('a', 'failed', 2, 20),
      runEnd('r1'),
      runStart('mine', 'r2'),
      nodeStart('a'),
      verdict('a', 'done', 1, 5),
      closed('a'),
      runEnd('r2'),
    ];
    const state = foldRunState(lines, 'mine', ['a']);
    expect(state.runId).toBe('r2');
    expect(state.started).toBe(true);
    expect(state.ended).toBe(true);
    expect(state.nodes.a).toEqual({ status: 'closed', attempts: 1, durationMs: 5 });
  });

  test('a run-end whose journalCopy names another run does not end ours', () => {
    const lines = [runStart('mine', 'r1'), nodeStart('a'), runEnd('another-run')];
    const state = foldRunState(lines, 'mine', ['a']);
    expect(state.started).toBe(true);
    expect(state.ended).toBe(false);
    expect(state.nodes.a?.status).toBe('running');
  });

  test('a node-start with no verdict is running', () => {
    const state = foldRunState([runStart('mine', 'r1'), nodeStart('a')], 'mine', ['a']);
    expect(state.ended).toBe(false);
    expect(state.nodes.a?.status).toBe('running');
  });

  test.each<[string, NodeStatus]>([
    ['failed', 'failed'],
    ['dead', 'failed'],
    ['timeout', 'failed'],
    ['rejected', 'failed'],
    ['blocked', 'blocked'],
    ['aborted', 'aborted'],
  ])('a %s verdict settles its node %s', (verdictStatus, nodeStatus) => {
    const state = foldRunState(
      [runStart('mine', 'r1'), nodeStart('a'), verdict('a', verdictStatus, 3, 30)],
      'mine',
      ['a'],
    );
    expect(state.nodes.a?.status).toBe(nodeStatus);
    expect(state.nodes.a?.attempts).toBe(3);
    expect(state.nodes.a?.durationMs).toBe(30);
  });

  test('a done verdict closes to closed, keeping attempts and duration', () => {
    const state = foldRunState(
      [
        runStart('mine', 'r1'),
        nodeStart('a'),
        verdict('a', 'done', 1, 5),
        closed('a'),
        runEnd('r1'),
      ],
      'mine',
      ['a'],
    );
    expect(state.nodes.a).toEqual({ status: 'closed', attempts: 1, durationMs: 5 });
  });

  test('a done verdict the ledger declines closes to partial', () => {
    const state = foldRunState(
      [
        runStart('mine', 'r1'),
        nodeStart('a'),
        verdict('a', 'done', 1, 5),
        notClosed('a'),
        runEnd('r1'),
      ],
      'mine',
      ['a'],
    );
    expect(state.nodes.a).toEqual({ status: 'partial', attempts: 1, durationMs: 5 });
  });

  test('a node never started when the run ends is skipped', () => {
    const state = foldRunState(
      [
        runStart('mine', 'r1'),
        nodeStart('a'),
        verdict('a', 'done', 1, 5),
        closed('a'),
        runEnd('r1'),
      ],
      'mine',
      ['a', 'b'],
    );
    expect(state.nodes.a?.status).toBe('closed');
    expect(state.nodes.b?.status).toBe('skipped');
  });

  test('node lines whose id is not in the plan are ignored', () => {
    const state = foldRunState(
      [runStart('mine', 'r1'), nodeStart('other'), verdict('other', 'done'), runEnd('r1')],
      'mine',
      ['a'],
    );
    expect(state.nodes.a?.status).toBe('skipped');
  });

  // ledger: D31 — a resumed run's already-verified nodes are verified, not skipped.
  test('a node the run-end lists as already verified is verified', () => {
    const state = foldRunState(
      [
        runStart('mine', 'r1'),
        nodeStart('b'),
        verdict('b', 'done'),
        closed('b'),
        runEnd('r1', ['a']),
      ],
      'mine',
      ['a', 'b'],
    );
    expect(state.nodes.a?.status).toBe('verified' as NodeStatus);
    expect(state.nodes.b?.status).toBe('closed');
  });

  // ledger: D31 — a run-end is ours by the runId it carries, not by a path.
  test('a run-end carrying another runId does not end ours, even with no journalCopy', () => {
    const other = { event: 'run-end', runId: 'r9', closed: [], failed: [] };
    const state = foldRunState([runStart('mine', 'r1'), nodeStart('a'), other], 'mine', ['a']);
    expect(state.ended).toBe(false);
    expect(state.nodes.a?.status).toBe('running');
  });

  // issue #63 — a running node's attempt, phase and gate come from the journal.
  test('a running node mid-gate reports its attempt and the gate in flight', () => {
    const state = foldRunState(
      [runStart('mine', 'r1'), nodeStart('a'), attemptStart('a', 1), gateStart('a', 'smoke')],
      'mine',
      ['a'],
    );
    expect(state.nodes.a).toEqual({ status: 'running', attempt: 1, gate: 'smoke' });
  });

  test('a gate-end clears the gate, leaving the attempt', () => {
    const state = foldRunState(
      [
        runStart('mine', 'r1'),
        nodeStart('a'),
        attemptStart('a', 1),
        gateStart('a', 'smoke'),
        gateEnd('a', 'smoke'),
      ],
      'mine',
      ['a'],
    );
    expect(state.nodes.a).toEqual({ status: 'running', attempt: 1 });
  });

  test('a running node mid-phase reports its attempt and the current phase', () => {
    const state = foldRunState(
      [runStart('mine', 'r1'), nodeStart('a'), attemptStart('a', 1), phaseStart('a', 'impl', 1)],
      'mine',
      ['a'],
    );
    expect(state.nodes.a).toEqual({ status: 'running', attempt: 1, phase: 'impl' });
  });

  test('a node on its second attempt reports attempt 2', () => {
    const state = foldRunState(
      [runStart('mine', 'r1'), nodeStart('a'), attemptStart('a', 2), gateStart('a', 'smoke')],
      'mine',
      ['a'],
    );
    expect(state.nodes.a).toEqual({ status: 'running', attempt: 2, gate: 'smoke' });
  });

  test('a verdict drops the running attempt/phase/gate, keeping its own attempts', () => {
    const state = foldRunState(
      [
        runStart('mine', 'r1'),
        nodeStart('a'),
        attemptStart('a', 2),
        gateStart('a', 'smoke'),
        verdict('a', 'failed', 2, 20),
      ],
      'mine',
      ['a'],
    );
    expect(state.nodes.a).toEqual({ status: 'failed', attempts: 2, durationMs: 20 });
  });
});
