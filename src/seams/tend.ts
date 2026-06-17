import { TendTransportError } from '../core/errors.ts';
import type { Verdict } from '../core/plan.ts';
import type { LedgerSeam } from '../loop/deps.ts';

// The bridge interface pleach requires from tend's ingester module.
// readClosed returns Set (pre-T1) or Map (T1+); emitVerdict signature
// matches the real ingester exactly: (v, source) → {closed}.
export interface TendTransport {
  readClosed(source: string): Promise<Set<string> | Map<string, string | null>>;
  emitVerdict(v: Verdict, source: string): Promise<{ closed: boolean }>;
}

// Adapt a Set<id> (pre-T1 tend, no SHAs recorded) to the
// Map<id, sha | null> the loop always works with (null = legacy / no SHA).
function adaptToMap(raw: Set<string> | Map<string, string | null>): Map<string, string | null> {
  if (raw instanceof Map) return raw;
  const out = new Map<string, string | null>();
  for (const id of raw) out.set(id, null);
  return out;
}

// Translate plan.source (feature polyglot path: {root}/docs/tend/features/{id}.tend.html)
// to the project root the transport (ingester) requires. Convention: the feature file
// is 4 path segments below the root (docs/ → tend/ → features/ → {id}.tend.html).
// If the path does not contain the expected segment, it is assumed to be a root
// already and is returned unchanged.
function toProjectRoot(source: string): string {
  const marker = '/docs/tend/features/';
  const idx = source.indexOf(marker);
  if (idx === -1) return source;
  return source.slice(0, idx);
}

// createTendSeam wraps a TendTransport with a serial promise-chain queue so
// that at most one transport call is in flight at any time, even when callers
// fire concurrently (single-ingester invariant — ENGINEERING.md concurrency
// invariants). The queue is FIFO: calls resolve in the order they were
// enqueued.
export function createTendSeam(transport: TendTransport): LedgerSeam {
  // The tail of the promise chain. Every new call chains off this tail so
  // calls never overlap and always execute in arrival order.
  let tail: Promise<unknown> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = tail.then(fn, fn); // resolve or reject → next call runs
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    readClosed(source: string): Promise<Map<string, string | null>> {
      return enqueue(async () => {
        const raw = await transport.readClosed(toProjectRoot(source));
        return adaptToMap(raw);
      });
    },
    emitVerdict(v: Verdict, source: string): Promise<{ closed: boolean }> {
      return enqueue(() => transport.emitVerdict(v, toProjectRoot(source)));
    },
  };
}

// createModuleTransport dynamically imports tend's real ingester module and
// validates the required exports are present. Throws TendTransportError (not a
// generic Error) so callers can distinguish a misconfigured transport path from
// a real ingester failure.
export async function createModuleTransport(modulePath: string): Promise<TendTransport> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(modulePath)) as Record<string, unknown>;
  } catch (err) {
    throw new TendTransportError(
      modulePath,
      `dynamic import failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof mod.readClosed !== 'function') {
    throw new TendTransportError(modulePath, "missing export 'readClosed'");
  }
  if (typeof mod.emitVerdict !== 'function') {
    throw new TendTransportError(modulePath, "missing export 'emitVerdict'");
  }

  return {
    readClosed: mod.readClosed as TendTransport['readClosed'],
    emitVerdict: mod.emitVerdict as TendTransport['emitVerdict'],
  };
}
