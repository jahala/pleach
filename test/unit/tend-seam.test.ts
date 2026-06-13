/**
 * Unit tests for src/seams/tend.ts
 *
 * Subject: createTendSeam — the serialized-queue wrapper.
 * The transport objects here are REAL implementations of TendTransport (not mocks)
 * whose calls happen to be in-memory and fast. The subject under test is the queue
 * serialization logic — per ENGINEERING.md testing doctrine, in-memory seam
 * implementations are allowed in loop/unit tests when the subject is the
 * scheduling/queue logic itself.
 *
 * Tests:
 *  1. Queue serialization: concurrent calls produce no overlap (every start ≥ prev end)
 *     and execute in FIFO order.
 *  2. Set→Map adaptation: a Set<string> from readClosed becomes Map<id, null>.
 *  3. Map pass-through: a Map<string, string | null> is returned as-is.
 */
import { describe, expect, test } from 'bun:test';
import type { Verdict } from '../../src/core/plan.ts';
import type { TendTransport } from '../../src/seams/tend.ts';
import { createTendSeam } from '../../src/seams/tend.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeVerdict(node: string): Verdict {
  return {
    node,
    status: 'failed',
    output: null,
    evidence: { filesTouched: [] },
    telemetry: {},
    attempts: 1,
  };
}

// A real TendTransport whose calls are observable (start/end timestamps + order).
interface CallRecord {
  kind: 'readClosed' | 'emitVerdict';
  arg: string; // source or node id
  startMs: number;
  endMs: number;
}

function makeRecordingTransport(
  delayMs: number,
  result: Set<string> | Map<string, string | null>,
): { transport: TendTransport; records: CallRecord[] } {
  const records: CallRecord[] = [];

  const transport: TendTransport = {
    async readClosed(source: string): Promise<Set<string> | Map<string, string | null>> {
      const startMs = Date.now();
      await new Promise<void>((r) => setTimeout(r, delayMs));
      const endMs = Date.now();
      records.push({ kind: 'readClosed', arg: source, startMs, endMs });
      return result;
    },
    async emitVerdict(v: Verdict, _source: string): Promise<{ closed: boolean }> {
      const startMs = Date.now();
      await new Promise<void>((r) => setTimeout(r, delayMs));
      const endMs = Date.now();
      records.push({ kind: 'emitVerdict', arg: v.node, startMs, endMs });
      return { closed: false };
    },
  };

  return { transport, records };
}

// ── Queue serialization ───────────────────────────────────────────────────────

describe('createTendSeam — queue serialization', () => {
  test('5 concurrent calls execute with no overlap and in FIFO order', async () => {
    const { transport, records } = makeRecordingTransport(20, new Set<string>());
    const seam = createTendSeam(transport);
    const source = '/tmp/garden';

    // Fire 5 calls concurrently. Interleaved: readClosed, emitVerdict, readClosed, emitVerdict, readClosed
    const calls = [
      seam.readClosed(source),
      seam.emitVerdict(makeVerdict('n1'), source),
      seam.readClosed(source),
      seam.emitVerdict(makeVerdict('n2'), source),
      seam.readClosed(source),
    ];

    await Promise.all(calls);

    expect(records).toHaveLength(5);

    // FIFO: records arrive in the order they were enqueued.
    // Even-index (0,2,4) → readClosed; odd-index (1,3) → emitVerdict.
    expect(records[0]?.kind).toBe('readClosed');
    expect(records[1]?.kind).toBe('emitVerdict');
    expect(records[1]?.arg).toBe('n1');
    expect(records[2]?.kind).toBe('readClosed');
    expect(records[3]?.kind).toBe('emitVerdict');
    expect(records[3]?.arg).toBe('n2');
    expect(records[4]?.kind).toBe('readClosed');

    // No overlap: every start ≥ previous end.
    for (let i = 1; i < records.length; i++) {
      const prev = records[i - 1];
      const curr = records[i];
      if (!prev || !curr) continue;
      expect(curr.startMs).toBeGreaterThanOrEqual(prev.endMs);
    }
  });
});

// ── Set→Map adaptation ────────────────────────────────────────────────────────

describe('createTendSeam — Set→Map adaptation', () => {
  test('a Set<string> from readClosed becomes Map<id, null>', async () => {
    const setResult = new Set(['feat-a', 'feat-b']);
    const { transport } = makeRecordingTransport(0, setResult);
    const seam = createTendSeam(transport);

    const result = await seam.readClosed('/tmp/garden');

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);
    expect(result.get('feat-a')).toBeNull();
    expect(result.get('feat-b')).toBeNull();
    expect(result.has('feat-c')).toBe(false);
  });

  test('an empty Set becomes an empty Map', async () => {
    const { transport } = makeRecordingTransport(0, new Set<string>());
    const seam = createTendSeam(transport);

    const result = await seam.readClosed('/tmp/garden');

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test('a Map<string, string | null> passes through unchanged', async () => {
    const mapResult = new Map<string, string | null>([
      ['feat-a', 'abc123'],
      ['feat-b', null],
    ]);
    const { transport } = makeRecordingTransport(0, mapResult);
    const seam = createTendSeam(transport);

    const result = await seam.readClosed('/tmp/garden');

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);
    expect(result.get('feat-a')).toBe('abc123');
    expect(result.get('feat-b')).toBeNull();
  });

  test('emitVerdict result passes through from transport', async () => {
    const { transport } = makeRecordingTransport(0, new Set<string>());
    const seam = createTendSeam(transport);

    const result = await seam.emitVerdict(makeVerdict('n1'), '/tmp/garden');

    expect(result).toEqual({ closed: false });
  });
});
