// The schedule of waits for a provider error (issue #151): the provider's or
// the network's fault, never the work's, so it is retried within the SAME
// attempt rather than spending one. Five waits, doubling from 15 s — about 7.5
// minutes in all, after which the caller counts the attempt as failed exactly
// as it would have today.
//
// Pure and total: `retryIndex` is how many waits the attempt has already
// spent; the answer is the next wait in milliseconds, or null once the budget
// is gone. The loop owns the clock — this only names the schedule.

// The first wait when the run sets none (`--provider-backoff-ms`); each next
// wait doubles it, five waits in all (D34).
export const DEFAULT_PROVIDER_BACKOFF_MS = 15_000;
const PROVIDER_WAITS = 5;

export function providerBackoff(
  retryIndex: number,
  baseMs: number = DEFAULT_PROVIDER_BACKOFF_MS,
): number | null {
  return retryIndex >= 0 && retryIndex < PROVIDER_WAITS ? baseMs * 2 ** retryIndex : null;
}
