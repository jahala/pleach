// The envelope on the real seam, against the real filesystem.
// ledger: D15 (jahala/pleach#60, jahala/plotplot#16)
//
// The unit tests pin `envelope` as a function. This pins the seam that is the
// journal's one exit: every line it appends to a real file carries the
// envelope, the narrator sees the SAME enveloped line the file holds, and the
// fields the loop appended survive the round trip through JSON. The clock is
// the seam's own — nothing is injected here, so `time` is checked against the
// wall clock either side of the append.
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KINDS } from '../../src/core/journal-envelope.ts';
import { createJournal } from '../../src/seams/journal.ts';

const JOURNAL_DOC = new URL('../../docs/journal.md', import.meta.url).pathname;

const UNIVERSAL = [
  'time',
  'event.name',
  'plotplot.kind',
  'plotplot.count',
  'plotplot.harness',
  'gen_ai.conversation.id',
] as const;

async function tmpJournal(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pleach-journal-envelope-'));
  return join(dir, 'journal.jsonl');
}

async function lines(path: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The mirrors the profile requires of a kind — restated here, not imported. */
function expectedMirrors(kind: string): { node: boolean; gate: boolean } {
  return {
    node: kind !== 'run.lifecycle',
    gate: kind === 'gate.result' || kind === 'gate.retry',
  };
}

describe('journal seam — the friction profile envelope', () => {
  test('every documented event gains the envelope its kind pins', async () => {
    const path = await tmpJournal();
    const journal = createJournal(path);

    // The whole pinned table, not a sample: a kind added without the seam
    // writing its mirrors is the failure this catches.
    const names = Object.keys(KINDS);
    const before = Date.now();
    for (const name of names) {
      await journal.append({ event: name, node: `${name}-node`, gate: 'smoke' });
    }
    const after = Date.now();

    const written = await lines(path);
    expect(written).toHaveLength(names.length);

    for (const [i, name] of names.entries()) {
      const line = written[i] as Record<string, unknown>;
      const kind = KINDS[name];
      expect(line.event).toBe(name);
      expect(line['event.name']).toBe(`pleach.${name}`);
      expect(line['plotplot.kind']).toBe(kind);
      expect(line['plotplot.count']).toBe(1);
      expect(line['plotplot.harness']).toBeNull();
      expect(line['gen_ai.conversation.id']).toBeNull();
      expect(Object.keys(line)).not.toContain('gen_ai.provider.name');

      // The seam owns the clock: a real UTC instant from the append itself.
      const time = line.time;
      expect(typeof time).toBe('string');
      expect(time as string).toEndWith('Z');
      const ms = Date.parse(time as string);
      expect(ms).toBeGreaterThanOrEqual(before);
      expect(ms).toBeLessThanOrEqual(after);

      const mirrors = expectedMirrors(kind as string);
      expect(Object.hasOwn(line, 'plotplot.node')).toBe(mirrors.node);
      expect(Object.hasOwn(line, 'plotplot.gate')).toBe(mirrors.gate);
      if (mirrors.node) expect(line['plotplot.node']).toBe(`${name}-node`);
      if (mirrors.gate) expect(line['plotplot.gate']).toBe('smoke');
    }
  });

  test('a land-level gate line mirrors a node it does not have as null', async () => {
    const path = await tmpJournal();
    const journal = createJournal(path);

    await journal.append({ event: 'land-gate', commands: ['bun test'], sinks: ['a', 'b'] });

    const [line] = await lines(path);
    expect(line?.['plotplot.kind']).toBe('gate.result');
    expect(Object.hasOwn(line as object, 'plotplot.node')).toBe(true);
    expect(line?.['plotplot.node']).toBeNull();
    expect(line?.['plotplot.gate']).toBeNull();
  });

  test('every field the loop appended round-trips through the file', async () => {
    const path = await tmpJournal();
    const journal = createJournal(path);

    // The events as run-plan appends them, fields per docs/journal.md.
    const appended: Record<string, unknown>[] = [
      { event: 'run-start', goal: 'ship the envelope', nodes: 3 },
      { event: 'node-start', node: 'rules-block' },
      { event: 'gate-retry', node: 'rules-block', gate: 'smoke' },
      {
        event: 'verdict',
        node: 'rules-block',
        status: 'verified',
        attempts: 2,
        telemetry: { tokens: 4211 },
        durationMs: 91_004,
        provider: 'claude',
        model: 'claude-opus-5',
        gate: { ran: 'bun test', exitCode: 0 },
      },
      {
        event: 'closed',
        node: 'rules-block',
        sha: 'a'.repeat(40),
        degraded: ['audit:unconfigured'],
      },
      { event: 'run-end', closed: 1, failed: 0, skipped: 0, blocked: 0 },
    ];

    for (const event of appended) await journal.append(event);

    const written = await lines(path);
    expect(written).toHaveLength(appended.length);
    for (const [i, event] of appended.entries()) {
      const line = written[i] as Record<string, unknown>;
      // Not "the fields are present" — the value that came back is the value
      // that went in, nested structures included.
      for (const [key, value] of Object.entries(event)) {
        expect(line[key]).toEqual(value);
      }
    }

    // The verdict line names who ran the work, under the profile's names.
    const verdict = written[3] as Record<string, unknown>;
    expect(verdict['plotplot.runner']).toBe('claude');
    expect(verdict['gen_ai.request.model']).toBe('claude-opus-5');
  });

  test('appending does not mutate the caller their event object', async () => {
    const path = await tmpJournal();
    const journal = createJournal(path);

    const event = { event: 'node-start', node: 'rules-block' };
    await journal.append(event);

    expect(event).toEqual({ event: 'node-start', node: 'rules-block' });
  });

  test('the narrator sees the same enveloped line the file holds', async () => {
    const path = await tmpJournal();
    const seen: Record<string, unknown>[] = [];
    const journal = createJournal(path, (e) => seen.push(e));

    await journal.append({ event: 'gate-retry', node: 'rules-block', gate: 'smoke' });
    await journal.append({ event: 'run-end', closed: 1 });

    const written = await lines(path);
    // One stream, two renderings: an observer that had to re-derive the
    // envelope would be a second source of truth for it.
    expect(seen).toEqual(written);
    for (const key of UNIVERSAL) expect(Object.hasOwn(seen[0] as object, key)).toBe(true);
  });

  test('a throwing narrator still leaves an enveloped line on disk', async () => {
    const path = await tmpJournal();
    const journal = createJournal(path, () => {
      throw new Error('renderer bug');
    });

    await journal.append({ event: 'closed', node: 'x', sha: 'abc' });

    const [line] = await lines(path);
    expect(line?.['event.name']).toBe('pleach.closed');
    expect(line?.['plotplot.node']).toBe('x');
  });

  test('docs/journal.md documents the envelope', async () => {
    const doc = await readFile(JOURNAL_DOC, 'utf8');
    // The section sits after the events table, so the read surface's promise
    // covers the envelope too.
    const section = doc.slice(doc.indexOf('\n## Events\n'));
    expect(section).not.toBe('');

    // Named, not quoted back: the failure lists what the doc is missing.
    const wanted = [
      ...UNIVERSAL,
      ...new Set(Object.values(KINDS)),
      // Where the kinds come from, and what the runner attribute is.
      'friction-profile.md',
      'plotplot.runner',
    ];
    expect(wanted.filter((term) => !section.includes(term))).toEqual([]);
  });
});
