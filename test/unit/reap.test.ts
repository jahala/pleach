import { describe, expect, test } from 'bun:test';
import { unreapedSessions } from '../../src/core/reap.ts';

// issue #115 — the pure half of `pleach clean`'s session sweep: from the
// journal lines, the sessions a run spawned and never killed or reaped. Pure
// and total — malformed lines are skipped, and a session that was spawned,
// killed and spawned again is unreaped when the later spawn has no later kill.

describe('unreapedSessions', () => {
  test('a spawned session with no later kill or reap is unreaped', () => {
    const out = unreapedSessions([{ event: 'worker-spawned', node: 'a', session: 'pl-1' }]);
    expect(out).toEqual([{ node: 'a', session: 'pl-1' }]);
  });

  test('a spawned session later killed is not unreaped', () => {
    const out = unreapedSessions([
      { event: 'worker-spawned', node: 'a', session: 'pl-1' },
      { event: 'worker-killed', node: 'a', session: 'pl-1' },
    ]);
    expect(out).toEqual([]);
  });

  test('a spawned session later reaped is not unreaped', () => {
    const out = unreapedSessions([
      { event: 'worker-spawned', node: 'a', session: 'pl-1' },
      { event: 'worker-reaped', node: 'a', session: 'pl-1', outcome: 'killed' },
    ]);
    expect(out).toEqual([]);
  });

  test('only the latest spawn decides: re-spawned without a later kill is unreaped', () => {
    const out = unreapedSessions([
      { event: 'worker-spawned', node: 'a', session: 'pl-1' },
      { event: 'worker-killed', node: 'a', session: 'pl-1' },
      { event: 'worker-spawned', node: 'a', session: 'pl-1' },
    ]);
    expect(out).toEqual([{ node: 'a', session: 'pl-1' }]);
  });

  test('sessions are independent, in first-spawn order', () => {
    const out = unreapedSessions([
      { event: 'worker-spawned', node: 'b', session: 'pl-2' },
      { event: 'worker-spawned', node: 'a', session: 'pl-1' },
      { event: 'worker-killed', node: 'b', session: 'pl-2' },
    ]);
    expect(out).toEqual([{ node: 'a', session: 'pl-1' }]);
  });

  test('malformed lines are ignored, never thrown on', () => {
    const out = unreapedSessions([
      { event: 'worker-spawned', node: 'a' }, // no session
      { event: 'worker-spawned', session: 'pl-1' }, // no node
      { event: 'worker-killed', node: 'a', session: 'pl-1' }, // kill before any spawn
      { event: 'something-else', session: 'pl-9' },
    ]);
    expect(out).toEqual([]);
  });

  test('a journal of tens of thousands of lines is handled', () => {
    const lines: Record<string, unknown>[] = [];
    for (let i = 0; i < 50_000; i += 1) {
      lines.push({ event: 'worker-spawned', node: `node-${i}`, session: `pl-${i}` });
      if (i % 2 === 0) {
        lines.push({ event: 'worker-killed', node: `node-${i}`, session: `pl-${i}` });
      }
    }
    const out = unreapedSessions(lines);
    expect(out.length).toBe(25_000);
    expect(out[0]).toEqual({ node: 'node-1', session: 'pl-1' });
    expect(out.at(-1)).toEqual({ node: 'node-49999', session: 'pl-49999' });
  });
});
