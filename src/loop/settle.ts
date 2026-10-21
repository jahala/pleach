import { GateFailedError } from '../core/errors.ts';
import { decideSettle, SETTLE_BOUND_MS, SETTLE_WINDOW_MS } from '../core/settle.ts';
import type { IsolateSeam, JournalSeam } from './deps.ts';

// issue #127 — wait for the tree to settle after a worker stops, before any
// gate reads it. The loop composes the isolate seam's recordTree with the
// injected sleep; the pure decision (core/settle) says when to stop. A tree
// still changing past the bound is a retryable `settle` gate failure naming the
// paths that moved; a run's own signal cuts the settle wait short and settles
// aborted.

export type SettleOutcome =
  | { kind: 'settled'; waitedMs: number; windows: number }
  | { kind: 'aborted' };

// The narrow slice of the world this loop needs — recordTree and a read-only
// tree diff to name what is still changing, the injected sleep, and the journal.
export interface SettleDeps {
  isolate: Pick<IsolateSeam, 'recordTree' | 'treeDiffPaths'>;
  sleep: (ms: number) => Promise<void>;
  journal: Pick<JournalSeam, 'append'>;
}

// The changing paths are journaled capped, with the real total beside them, so
// a tree that rewrites a whole map does not flood the line.
const SETTLE_PATHS_CAP = 50;

// Sleep one settle window, cut short by the run's own signal (D16).
async function sleepWindow(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<'slept' | 'aborted'> {
  if (signal === undefined) {
    await sleep(ms);
    return 'slept';
  }
  return new Promise<'slept' | 'aborted'>((resolve) => {
    if (signal.aborted) {
      resolve('aborted');
      return;
    }
    let done = false;
    const finish = (r: 'slept' | 'aborted'): void => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const onAbort = (): void => finish('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    void sleep(ms).then(() => finish('slept'));
  });
}

// Record the tree, wait a settle window, record again, and repeat until two
// consecutive records are equal — a settled tree. `timing` overrides the
// constants, so an integration test can shrink the window without touching the
// loop's defaults.
export async function settleWorkingTree(
  nodeId: string,
  cwd: string,
  deps: SettleDeps,
  signal?: AbortSignal,
  timing: { windowMs?: number; boundMs?: number } = {},
): Promise<SettleOutcome> {
  const windowMs = timing.windowMs ?? SETTLE_WINDOW_MS;
  const boundMs = timing.boundMs ?? SETTLE_BOUND_MS;
  // A zero window turns the settle off (`--settle-ms 0`, D35).
  if (windowMs === 0) return { kind: 'settled', waitedMs: 0, windows: 0 };
  const records: string[] = [await deps.isolate.recordTree(cwd)];
  let waitedMs = 0;
  for (;;) {
    const decision = decideSettle(records, windowMs, boundMs);
    if (decision.kind === 'settled') {
      // A quiet tree (one window) adds no journal noise; only a settle that
      // took more than one window is recorded.
      if (records.length - 1 > 1) {
        await deps.journal.append({ event: 'tree-settled', node: nodeId, waitedMs });
      }
      return { kind: 'settled', waitedMs, windows: records.length - 1 };
    }
    if (decision.kind === 'still-changing') {
      const paths = await deps.isolate.treeDiffPaths(
        cwd,
        records[records.length - 2] as string,
        records[records.length - 1] as string,
      );
      await deps.journal.append({
        event: 'tree-still-changing',
        node: nodeId,
        paths: paths.slice(0, SETTLE_PATHS_CAP),
        count: paths.length,
      });
      throw new GateFailedError('settle', settleEvidence(paths), -1);
    }
    const slept = await sleepWindow(deps.sleep, windowMs, signal);
    if (slept === 'aborted') return { kind: 'aborted' };
    waitedMs += windowMs;
    records.push(await deps.isolate.recordTree(cwd));
  }
}

function settleEvidence(paths: readonly string[]): string {
  return (
    'The working tree was still changing when the settle window ended. ' +
    `Paths still changing:\n${paths.join('\n')}\n` +
    'Wait for the background work to finish, or stop it, before ending the turn.'
  );
}
