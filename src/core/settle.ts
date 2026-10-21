// issue #127 — a worker that ends its turn while its own background command
// still runs is read as finished. After a worker stops, the loop records the
// tree, waits a settle window, records again, and repeats until two
// consecutive records are equal. This module is the decision that loop reads:
// pure and total — it takes the recorded tree ids and the window/bound, never
// a clock, never the file system.

export const SETTLE_WINDOW_MS = 2000;
export const SETTLE_BOUND_MS = 60_000;

export type SettleDecision =
  | { kind: 'settled' }
  | { kind: 'keep-waiting' }
  | { kind: 'still-changing'; windows: number };

// `records` is the sequence of tree ids recorded so far, one before the first
// window and one after each window. The number of windows elapsed is
// `records.length - 1`. Two equal consecutive records are a settled tree; past
// the bound it is still-changing; otherwise keep waiting.
export function decideSettle(
  records: readonly string[],
  windowMs: number = SETTLE_WINDOW_MS,
  boundMs: number = SETTLE_BOUND_MS,
): SettleDecision {
  const n = records.length;
  if (n >= 2 && records[n - 1] === records[n - 2]) return { kind: 'settled' };
  const windows = n - 1;
  if (windows * windowMs >= boundMs) return { kind: 'still-changing', windows };
  return { kind: 'keep-waiting' };
}
