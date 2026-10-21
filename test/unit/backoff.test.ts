import { describe, expect, test } from 'bun:test';
import { providerBackoff } from '../../src/core/backoff.ts';

// ledger: #151 — a provider error is the provider's or the network's fault,
// never the work's, so it is retried within the SAME attempt on a backoff
// schedule instead of spending an attempt. The schedule lives in core/ as a
// pure function so the loop owns the clock and this owns the numbers alone.

describe('providerBackoff — the schedule for a provider error (issue #151)', () => {
  test('the five waits double from 15 s, then the budget is spent (null)', () => {
    expect([
      providerBackoff(0),
      providerBackoff(1),
      providerBackoff(2),
      providerBackoff(3),
      providerBackoff(4),
      providerBackoff(5),
    ]).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, null]);
  });

  test('any index past the budget is null (total, no surprise)', () => {
    expect(providerBackoff(6)).toBeNull();
    expect(providerBackoff(100)).toBeNull();
  });
});
