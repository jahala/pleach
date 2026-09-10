import { describe, expect, test } from 'bun:test';
import { JournalEventUnknownError } from '../../src/core/errors.ts';
import { envelope, KINDS } from '../../src/core/journal-envelope.ts';

// ---------------------------------------------------------------------------
// ledger: D15 — one envelope for the garden's three append-only streams. This
// pins the universal half: what `envelope` adds to EVERY line the run journal
// writes, from an injected clock, with the kind read from one pinned table.
// The node/gate mirrors and the verdict attributes are their own checks.
// ---------------------------------------------------------------------------

/** The kinds the umbrella pins for pleach (friction-profile.md v1.1.0 + the kinds PR). */
const PINNED_KINDS = ['gate.retry', 'run.lifecycle', 'node.lifecycle', 'gate.result'];

const CLOCK = new Date('2026-09-06T14:03:47.118Z');

describe('journal envelope — the pinned table', () => {
  test('is non-vacuous and names only pinned kinds', () => {
    const names = Object.keys(KINDS);
    expect(names.length).toBeGreaterThan(20);
    const unpinned = [...new Set(Object.values(KINDS))]
      .filter((kind) => !PINNED_KINDS.includes(kind))
      .sort();
    expect(unpinned).toEqual([]);
  });

  test('pins the profile fixture and the land-prefixed split the profile draws', () => {
    // `gate.retry` is the kind pinned in v1.1.0 itself; the other three come
    // with the kinds PR. `land-*` does not decide the kind — what the line
    // reports does: a gate outcome is `gate.result`, everything else in a
    // landing is `run.lifecycle`.
    expect(KINDS['gate-retry']).toBe('gate.retry');
    expect(KINDS['run-start']).toBe('run.lifecycle');
    expect(KINDS['land-setup']).toBe('run.lifecycle');
    expect(KINDS.verdict).toBe('node.lifecycle');
    expect(KINDS['gate-fail']).toBe('gate.result');
    expect(KINDS['land-gate']).toBe('gate.result');
    expect(KINDS['land-setup-failed']).toBe('gate.result');
  });
});

describe('journal envelope — the universal keys', () => {
  test('every event in the table gets its kind, its namespaced name and the constants', () => {
    for (const [name, kind] of Object.entries(KINDS)) {
      const line = envelope({ event: name }, CLOCK);
      expect(line['event.name']).toBe(`pleach.${name}`);
      expect(line['plotplot.kind']).toBe(kind);
      expect(line['plotplot.count']).toBe(1);
      expect(line['plotplot.harness']).toBeNull();
      expect(line['gen_ai.conversation.id']).toBeNull();
      expect(line.time).toBe('2026-09-06T14:03:47.118Z');
    }
  });

  test('the null keys are present, not absent, and survive serialisation', () => {
    const line = envelope({ event: 'run-start' }, CLOCK);
    expect(Object.keys(line)).toContain('plotplot.harness');
    expect(Object.keys(line)).toContain('gen_ai.conversation.id');
    const written = JSON.parse(JSON.stringify(line)) as Record<string, unknown>;
    expect(written['plotplot.harness']).toBeNull();
    expect(written['gen_ai.conversation.id']).toBeNull();
  });

  test('`time` is RFC 3339 UTC ending in Z, and comes from the injected clock only', () => {
    const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
    for (const iso of ['2026-01-01T00:00:00.000Z', '2019-12-31T23:59:59.007Z']) {
      const line = envelope({ event: 'run-end' }, new Date(iso));
      expect(line.time).toBe(iso);
      expect(line.time as string).toMatch(rfc3339);
    }
  });
});

describe('journal envelope — pure and total', () => {
  const event = {
    event: 'verdict',
    node: 'rules-block',
    status: 'verified',
    attempts: 2,
    telemetry: { tokens: 12_040 },
    degraded: ['smoke:unconfigured'],
    blockedReason: null,
    quiet: false,
    durationMs: 0,
  };

  test('preserves every input field verbatim, its own keys first', () => {
    const line = envelope(event, CLOCK);
    for (const [key, value] of Object.entries(event)) {
      expect(line[key]).toEqual(value);
    }
    expect(Object.keys(line).slice(0, Object.keys(event).length)).toEqual(Object.keys(event));
  });

  test('does not mutate its input and returns an equal line for an equal input', () => {
    const before = structuredClone(event);
    const first = envelope(event, CLOCK);
    const second = envelope(structuredClone(event), CLOCK);
    expect(event).toEqual(before);
    expect(second).toEqual(first);
    first.node = 'mutated';
    expect(event.node).toBe('rules-block');
  });

  test('an event name with no pinned kind is a typed throw, never a default kind', () => {
    let thrown: unknown;
    try {
      envelope({ event: 'gate-retried', node: 'rules-block' }, CLOCK);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(JournalEventUnknownError);
    expect((thrown as JournalEventUnknownError).name).toBe('JournalEventUnknownError');
    expect((thrown as JournalEventUnknownError).event).toBe('gate-retried');
    expect((thrown as Error).message).toContain('gate-retried');
  });

  test('a line with no event name at all is the same typed throw, not a TypeError', () => {
    for (const malformed of [{}, { node: 'rules-block' }, { event: 7 }]) {
      expect(() => envelope(malformed, CLOCK)).toThrow(JournalEventUnknownError);
    }
  });
});
