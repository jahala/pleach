import { describe, expect, test } from 'bun:test';
import { decideSettle, SETTLE_BOUND_MS, SETTLE_WINDOW_MS } from '../../src/core/settle.ts';

// issue #127 — a worker that ends its turn while its own background command
// still runs is read as finished. The pure settle decision turns a sequence of
// recorded tree ids into settled / keep-waiting / still-changing, against the
// window count (records - 1) and the bound. The loop reads it, never a clock.

describe('decideSettle (issue #127)', () => {
  test('equal on first re-record → settled', () => {
    expect(decideSettle(['tree-a', 'tree-a'])).toEqual({ kind: 'settled' });
  });

  test('changing then equal → settled after N windows', () => {
    expect(decideSettle(['a', 'b', 'b'])).toEqual({ kind: 'settled' });
    // three distinct records is not yet settled, and under the bound: keep waiting
    expect(decideSettle(['a', 'b', 'c'])).toEqual({ kind: 'keep-waiting' });
  });

  test('changing past the bound → still-changing', () => {
    // 4 records = 3 windows; with a 1000ms window and 2000ms bound it has outrun it
    expect(decideSettle(['a', 'b', 'c', 'd'], 1000, 2000)).toEqual({
      kind: 'still-changing',
      windows: 3,
    });
  });

  test('a single record is never settled and never still-changing', () => {
    expect(decideSettle(['a']).kind).toBe('keep-waiting');
  });

  test('the defaults are the design window and bound', () => {
    expect(SETTLE_WINDOW_MS).toBe(2000);
    expect(SETTLE_BOUND_MS).toBe(60_000);
  });
});
