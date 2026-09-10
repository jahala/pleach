// The node and gate mirrors — the half of the envelope that depends on what
// the line reports.  ledger: D15 (jahala/pleach#60, jahala/plotplot#16)
//
// The umbrella authored a pleach journal line in the profile before pleach
// could write one, so there is an external answer key: this test vendors it
// verbatim and requires `envelope` to reproduce it key-for-key. Anything that
// drifts — a missing mirror, a spare key, a renamed attribute — parts pleach
// from the loader the fixture was written for.
//
// Provenance: test/fixtures/friction-pleach-line.jsonl is jahala/plotplot
// contracts/fixtures/friction.jsonl line 2 at tag v1.1.0 (a8933d5), verbatim.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { envelope, KINDS } from '../../src/core/journal-envelope.ts';

const FIXTURE_LINE = readFileSync(
  new URL('../fixtures/friction-pleach-line.jsonl', import.meta.url).pathname,
  'utf8',
).trim();

const FIXTURE = JSON.parse(FIXTURE_LINE) as Record<string, unknown>;

const CLOCK = new Date(FIXTURE.time as string);

const keysOf = (line: Record<string, unknown>) => Object.keys(line).sort();

/** Every event the table pins for a kind. */
const events = (kind: string) =>
  Object.entries(KINDS)
    .filter(([, pinned]) => pinned === kind)
    .map(([name]) => name);

describe('journal envelope — the contracts fixture', () => {
  test('the vendored line is the profile line it claims to be', () => {
    expect(FIXTURE).toEqual({
      event: 'gate-retry',
      node: 'rules-block',
      gate: 'smoke',
      time: '2026-09-06T14:03:47.118Z',
      'event.name': 'pleach.gate-retry',
      'plotplot.kind': 'gate.retry',
      'plotplot.count': 1,
      'plotplot.harness': null,
      'gen_ai.conversation.id': null,
      'plotplot.node': 'rules-block',
      'plotplot.gate': 'smoke',
    });
  });

  test('`envelope` reproduces it key-for-key from the event alone', () => {
    const line = envelope({ event: 'gate-retry', node: 'rules-block', gate: 'smoke' }, CLOCK);
    expect(keysOf(line)).toEqual(keysOf(FIXTURE));
    expect(line).toEqual(FIXTURE);
  });
});

describe('journal envelope — the mirrors, by kind', () => {
  test('node.lifecycle lines mirror `node` and carry no gate key', () => {
    for (const name of events('node.lifecycle')) {
      const line = envelope({ event: name, node: 'rules-block' }, CLOCK);
      expect(line['plotplot.node']).toBe('rules-block');
      expect(Object.keys(line)).not.toContain('plotplot.gate');
    }
  });

  test('gate.result and gate.retry lines mirror both `node` and `gate`', () => {
    for (const name of [...events('gate.result'), ...events('gate.retry')]) {
      const line = envelope({ event: name, node: 'rules-block', gate: 'smoke' }, CLOCK);
      expect(line['plotplot.node']).toBe('rules-block');
      expect(line['plotplot.gate']).toBe('smoke');
    }
  });

  test('a land-level gate line has no node: the key is present and null', () => {
    for (const name of events('gate.result')) {
      const line = envelope({ event: name, gate: 'smoke' }, CLOCK);
      expect(Object.keys(line)).toContain('plotplot.node');
      expect(line['plotplot.node']).toBeNull();
      expect(line['plotplot.gate']).toBe('smoke');
    }
  });

  test('run.lifecycle lines carry neither mirror', () => {
    for (const name of events('run.lifecycle')) {
      const keys = Object.keys(envelope({ event: name, node: 'rules-block' }, CLOCK));
      expect(keys).not.toContain('plotplot.node');
      expect(keys).not.toContain('plotplot.gate');
    }
  });

  test('the mirror is the field, not a derivation of it', () => {
    const line = envelope({ event: 'gate-fail', node: 'a/b·c 1', gate: 'audit:opencode' }, CLOCK);
    expect(line['plotplot.node']).toBe('a/b·c 1');
    expect(line['plotplot.gate']).toBe('audit:opencode');
    // The event's own fields stay exactly as the loop appended them.
    expect(line.node).toBe('a/b·c 1');
    expect(line.gate).toBe('audit:opencode');
  });
});
