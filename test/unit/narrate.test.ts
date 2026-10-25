// W1 narration floor: narrateEvent turns journal events into plain-language
// stderr lines — one per event worth a human's glance, null for noise.
// Blocked-on-human is the shout: it must be unmissable and carry the reason.
import { describe, expect, test } from 'bun:test';
import { narrateEvent } from '../../src/faces/narrate.ts';

describe('narrateEvent (W1 narration floor)', () => {
  test('run-start names the node count and goal', () => {
    const line = narrateEvent({ event: 'run-start', goal: 'build the thing', nodes: 3 });
    expect(line).toContain('3');
    expect(line).toContain('build the thing');
  });

  test('node-start is a single plain line', () => {
    expect(narrateEvent({ event: 'node-start', node: 'api' })).toContain('api');
  });

  test('blocked is the shout: NEEDS YOU + node + reason', () => {
    const line = narrateEvent({ event: 'blocked', node: 'api', reason: 'permission prompt' });
    expect(line).toContain('NEEDS YOU');
    expect(line).toContain('api');
    expect(line).toContain('permission prompt');
  });

  test('closed reports the published branch and short sha', () => {
    const line = narrateEvent({ event: 'closed', node: 'api', sha: 'abcdef0123456789' });
    expect(line).toContain('node/api');
    expect(line).toContain('abcdef0');
    expect(line).not.toContain('abcdef0123456789');
  });

  test('verdict phrases terminal failure with attempts', () => {
    const line = narrateEvent({ event: 'verdict', node: 'api', status: 'failed', attempts: 2 });
    expect(line).toContain('api');
    expect(line).toContain('failed');
    expect(line).toContain('2');
  });

  // D19: a node settled where no gate says why (a gate that could not run, an
  // attempt left unspent — D17) carries the reason in `detail`; the operator
  // reading only stderr must see it, not just that the node failed.
  test('verdict carries its detail when the journal line has one', () => {
    const detail =
      'the environment cannot run the gate; fix the environment, no attempt can: ' +
      'Executable not found in $PATH: "nope"';
    const line = narrateEvent({
      event: 'verdict',
      node: 'api',
      status: 'failed',
      attempts: 1,
      detail,
    });
    expect(line).toContain('✗ api: failed after 1 attempt(s)');
    expect(line).toContain(detail);
  });

  test('verdict without a detail is the one line it always was', () => {
    const line = narrateEvent({ event: 'verdict', node: 'api', status: 'failed', attempts: 2 });
    expect(line).toBe('✗ api: failed after 2 attempt(s)');
  });

  // issue #106: a non-progress verdict carries a computed reason and next step;
  // the operator reading only stderr must see the next action, not just that
  // the node failed.
  test('verdict narrates its reason and next step when the line carries them', () => {
    const line = narrateEvent({
      event: 'verdict',
      node: 'api',
      status: 'failed',
      attempts: 1,
      reason: "'false' failed (exit 1)",
      nextStep: 're-run — the node resumes from quarantine/api',
    });
    expect(line).toContain("'false' failed (exit 1)");
    expect(line).toContain('next: re-run — the node resumes from quarantine/api');
  });

  test('quarantined points at the evidence branch', () => {
    const line = narrateEvent({ event: 'quarantined', node: 'api', branch: 'quarantine/api' });
    expect(line).toContain('quarantine/api');
  });

  test('handback-read-failed names the node, the read exit, and that a note stands in', () => {
    const line = narrateEvent({
      event: 'handback-read-failed',
      node: 'api',
      exitCode: 1,
      outputTail: 'no transcript',
    });
    expect(line).toContain('api');
    expect(line).toContain('1');
    expect(line).toContain('note');
  });

  test('run-end summarizes the buckets', () => {
    const line = narrateEvent({
      event: 'run-end',
      closed: ['a', 'b'],
      failed: ['c'],
      skipped: [],
      partial: [],
      blocked: [],
      quarantined: ['c'],
      alreadyVerified: [],
    });
    expect(line).toContain('2');
    expect(line).toContain('1');
  });

  test('diagnostic noise stays out of the narration', () => {
    expect(narrateEvent({ event: 'dispose-failed', node: 'x', detail: 'boom' })).toBeNull();
    expect(narrateEvent({ event: 'unknown-future-event' })).toBeNull();
  });

  // issue #63 — the narration floor speaks the gate events as they happen.
  test('a passing gate-end is one line with the duration in seconds', () => {
    const line = narrateEvent({
      event: 'gate-end',
      node: 'api',
      gate: 'smoke',
      attempt: 1,
      exitCode: 0,
      durationMs: 12300,
    });
    expect(line).toBe('▸ api: smoke passed (12.3s)');
  });

  test('a refused gate-end names the attempt and the tail first line', () => {
    const line = narrateEvent({
      event: 'gate-end',
      node: 'api',
      gate: 'hygiene',
      attempt: 1,
      exitCode: -1,
      durationMs: 50,
      outputTail: 'secret detected in src/x.ts\nsecond line',
    });
    expect(line).toBe('✗ api: hygiene refused (attempt 1)\nsecret detected in src/x.ts');
  });

  test('a refused gate-end with no tail stays one line', () => {
    const line = narrateEvent({
      event: 'gate-end',
      node: 'api',
      gate: 'marker',
      attempt: 2,
      exitCode: -1,
      durationMs: 1,
    });
    expect(line).toBe('✗ api: marker refused (attempt 2)');
  });

  test('audit-check is one short line per check verdict', () => {
    const line = narrateEvent({
      event: 'audit-check',
      node: 'api',
      check: 'c3',
      verdict: 'fail',
    });
    expect(line).toBe('· api: audit c3: fail');
  });

  test('attempt-start is narrated only on attempt 2 and up', () => {
    expect(narrateEvent({ event: 'attempt-start', node: 'api', attempt: 1 })).toBeNull();
    expect(narrateEvent({ event: 'attempt-start', node: 'api', attempt: 2 })).toBe(
      '↻ api: attempt 2',
    );
  });

  test('phase-start is narrated only on attempt 2 and up', () => {
    expect(
      narrateEvent({ event: 'phase-start', node: 'api', attempt: 1, phase: 'impl', index: 1 }),
    ).toBeNull();
    expect(
      narrateEvent({ event: 'phase-start', node: 'api', attempt: 2, phase: 'impl', index: 1 }),
    ).toBe('▸ api: phase impl');
  });

  test('gate-start is never narrated — the status verb carries it', () => {
    expect(narrateEvent({ event: 'gate-start', node: 'api', gate: 'smoke' })).toBeNull();
  });
});

// P6c (bandung): the narration printed the plan's whole goal paragraph on
// every run and land — the first sentence carries the identity; the rest is
// noise repeated twice per cycle.
describe('narrate clamps the goal to its first sentence', () => {
  const PARAGRAPH =
    'Build the tilth core. Then extract the slicer, wire the assembler, and verify the ' +
    'whole pipeline against the corpus with every edge case the map names.';

  test('run-start keeps only the first sentence', () => {
    const line = narrateEvent({ event: 'run-start', goal: PARAGRAPH, nodes: 3 });
    expect(line).toContain('Build the tilth core.');
    expect(line).not.toContain('extract the slicer');
  });

  test('land-start keeps only the first sentence', () => {
    const line = narrateEvent({ event: 'land-start', goal: PARAGRAPH });
    expect(line).toContain('Build the tilth core.');
    expect(line).not.toContain('extract the slicer');
  });

  test('a one-sentence goal passes through whole', () => {
    const line = narrateEvent({ event: 'run-start', goal: 'ship it', nodes: 1 });
    expect(line).toContain('ship it');
  });
});

describe('narration — a refused landing merge (D28)', () => {
  // ledger: D28 — a refusal is narrated as a refusal, never as a conflict.
  test('land-merge-refused names the ref and says it was refused', () => {
    const line = narrateEvent({ event: 'land-merge-refused', ref: 'node/one', outputTail: 'no' });
    expect(line).toContain('node/one');
    expect(line).toContain('refused');
    expect(line).not.toContain('conflict');
  });
});
