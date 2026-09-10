// The garden's one event envelope, added to every run-journal line.
// (ledger D15, jahala/pleach#60, jahala/plotplot#16)
//
// pleach, the friction journal and mull's spend log are three append-only
// JSONL streams written for one purpose; until this, each had its own
// envelope, so tend2's ledger face needed three loaders. The envelope is
// contracts/friction-profile.md at jahala/plotplot (v1.1.0 plus the kinds PR):
// the universal keys below on every line, whatever else the stream carries.
//
// This is the universal half — the keys that do not depend on what the line
// reports. The node and gate mirrors, and the verdict line's runner and model,
// are added beside these.
//
// Pure and total: the clock is a parameter, the input is never mutated, and an
// event this table has not pinned throws rather than guessing a kind.

import { JournalEventUnknownError } from './errors.ts';

export type Kind = 'gate.retry' | 'run.lifecycle' | 'node.lifecycle' | 'gate.result';

// The pinned kind for every event docs/journal.md documents. The doc's events
// table and this table are each other's completeness check: an event added to
// one without the other is the bug. Four kinds, because a kind invented per
// event is exactly what the profile forbids.
//
// `land-` does not decide the kind; what the line reports does. A landing's
// gate outcome is a `gate.result` like any other gate's, and the rest of a
// landing is the run's lifecycle.
export const KINDS: Record<string, Kind> = {
  // The kind pinned in the profile itself: an exec gate's one same-tree re-run.
  'gate-retry': 'gate.retry',

  // The run and the landing, beginning to end.
  'run-start': 'run.lifecycle',
  'run-end': 'run.lifecycle',
  'run-aborted': 'run.lifecycle',
  'land-start': 'run.lifecycle',
  'land-setup': 'run.lifecycle',
  'land-bisect': 'run.lifecycle',
  'land-culprit': 'run.lifecycle',
  'land-integrity-failed': 'run.lifecycle',
  'land-blocked': 'run.lifecycle',
  'land-conflict': 'run.lifecycle',
  landed: 'run.lifecycle',

  // One node's passage: dispatched, judged, closed or preserved, and every
  // record kept or refused along the way.
  'node-start': 'node.lifecycle',
  blocked: 'node.lifecycle',
  'phase-commit': 'node.lifecycle',
  'set-aside': 'node.lifecycle',
  'audit-egress-unparseable': 'node.lifecycle',
  verdict: 'node.lifecycle',
  closed: 'node.lifecycle',
  'not-closed': 'node.lifecycle',
  quarantined: 'node.lifecycle',
  'quarantine-failed': 'node.lifecycle',
  receipt: 'node.lifecycle',
  'gate-artifact': 'node.lifecycle',
  'receipt-write-failed': 'node.lifecycle',
  'acceptance-changed': 'node.lifecycle',
  'acceptance-cascade': 'node.lifecycle',
  'rebuild-required': 'node.lifecycle',
  'sha-mismatch': 'node.lifecycle',
  'dispose-failed': 'node.lifecycle',

  // A gate said yes or no.
  'gate-fail': 'gate.result',
  'gate-flaky': 'gate.result',
  'land-gate': 'gate.result',
  'land-gate-retry': 'gate.result',
  'land-setup-failed': 'gate.result',
};

function kindOf(name: unknown): Kind | undefined {
  // `Object.hasOwn` and not a bare lookup: the table is a plain object, so
  // `KINDS['toString']` would otherwise answer with something inherited.
  if (typeof name !== 'string' || !Object.hasOwn(KINDS, name)) return undefined;
  return KINDS[name];
}

/**
 * The line to write for `event`, observed at `now`: the event's own keys first
 * and verbatim, then the envelope's.
 *
 * @throws JournalEventUnknownError when the event name has no pinned kind.
 */
export function envelope(event: Record<string, unknown>, now: Date): Record<string, unknown> {
  const name = event.event;
  const kind = kindOf(name);
  if (kind === undefined) throw new JournalEventUnknownError(String(name));

  return {
    // A stream with its own `event` field keeps it; the envelope's name sits
    // beside it, source-namespaced, so one loader can tell three streams apart.
    ...event,
    time: now.toISOString(),
    'event.name': `pleach.${name}`,
    'plotplot.kind': kind,
    // One event, one line — pleach never batches, so the count is never > 1.
    'plotplot.count': 1,
    // Required keys, null because pleach has neither: it observes a runner's
    // process, not a harness turn, and a run is not one conversation. Null is
    // the answer "there is none"; an absent key would be "we never looked".
    'plotplot.harness': null,
    'gen_ai.conversation.id': null,
  };
}
