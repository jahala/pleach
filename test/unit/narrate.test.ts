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
