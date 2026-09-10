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

  test('quarantined points at the evidence branch', () => {
    const line = narrateEvent({ event: 'quarantined', node: 'api', branch: 'quarantine/api' });
    expect(line).toContain('quarantine/api');
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
