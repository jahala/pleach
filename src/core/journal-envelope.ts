// The garden's one event envelope, added to every run-journal line.
// (ledger D15, jahala/pleach#60, jahala/plotplot#16)
//
// pleach, the friction journal and mull's spend log are three append-only
// JSONL streams written for one purpose; until this, each had its own
// envelope, so tend2's ledger face needed three loaders. The envelope is
// contracts/friction-profile.md at jahala/plotplot (v1.1.0 plus the kinds PR):
// the universal keys below on every line, whatever else the stream carries.
//
// The universal keys are joined by the mirrors the profile requires per kind —
// the scope the line reports on, under the profile's name, so one loader can
// group three streams by node or by gate without knowing any stream's own
// field names. The verdict line's runner and model are added beside these.
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
  'run-stopped': 'run.lifecycle',
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
  'resumed-from-quarantine': 'node.lifecycle',
  'resume-refused': 'node.lifecycle',
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
  'land-gate-refused': 'gate.result',
  'land-setup-failed': 'gate.result',
};

// The attributes the profile requires beyond the envelope, by kind. Each is a
// field the event already carries, mirrored under the profile's name: the kind
// decides which scopes a line has, never the fields that happen to be on it.
// A required mirror is written even when the line has no such scope — a
// land-level gate belongs to no node, and `null` says so, where an absent key
// would say the question was never asked.
const MIRRORS: Record<Kind, readonly ('node' | 'gate')[]> = {
  'run.lifecycle': [],
  'node.lifecycle': ['node'],
  'gate.result': ['node', 'gate'],
  'gate.retry': ['node', 'gate'],
};

function kindOf(name: unknown): Kind | undefined {
  // `Object.hasOwn` and not a bare lookup: the table is a plain object, so
  // `KINDS['toString']` would otherwise answer with something inherited.
  if (typeof name !== 'string' || !Object.hasOwn(KINDS, name)) return undefined;
  return KINDS[name];
}

/**
 * The line to write for `event`, observed at `now`: the event's own keys first
 * and verbatim, then the envelope's, then the mirrors its kind requires.
 *
 * @throws JournalEventUnknownError when the event name has no pinned kind.
 */
export function envelope(event: Record<string, unknown>, now: Date): Record<string, unknown> {
  const name = event.event;
  const kind = kindOf(name);
  if (kind === undefined) throw new JournalEventUnknownError(String(name));

  const line: Record<string, unknown> = {
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

  for (const scope of MIRRORS[kind]) {
    line[`plotplot.${scope}`] = event[scope] ?? null;
  }

  // Who ran the work, under the profile's names. Driven by the fields the line
  // carries, not by its event name: today only `verdict` resolves a runner, and
  // a line that names none stays silent — the profile's "never told us" is an
  // absent key, not a null one. `gen_ai.provider.name` is never written: the
  // runner is a CLI name, and the provider behind it (Bedrock, Vertex) is not
  // observable from pleach.
  if (typeof event.provider === 'string') line['plotplot.runner'] = event.provider;
  if (typeof event.model === 'string') line['gen_ai.request.model'] = event.model;
  return line;
}
