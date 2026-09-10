import type { Check, LoopSpec } from '../make-plan.ts';

const PROFILE = [
  'The envelope is contracts/friction-profile.md at jahala/plotplot (v1.1.0 plus the kinds PR): universal keys on every line — `time` (RFC 3339 UTC ending in Z), `event.name` (a stream with its own `event` field keeps it and adds `event.name` beside it, source-namespaced: `pleach.gate-retry`), `plotplot.kind` (a pinned kind), `plotplot.count` (integer >= 1); `plotplot.harness` and `gen_ai.conversation.id` are required keys whose value is null when the domain has no harness / no single conversation (pleach: always null).',
  'Pinned kinds for pleach and their required attributes beyond the envelope: `gate.retry` (gate-retry: `plotplot.node`, `plotplot.gate`); `run.lifecycle` (run-start, run-end, run-aborted, land-start, landed, land-blocked, land-conflict, land-setup, land-bisect, land-culprit, land-integrity-failed: none); `node.lifecycle` (node-start, verdict, closed, not-closed, blocked, quarantined, quarantine-failed, receipt, receipt-write-failed, acceptance-changed, acceptance-cascade, rebuild-required, sha-mismatch, dispose-failed, audit-egress-unparseable, phase-commit, gate-artifact: `plotplot.node`); `gate.result` (gate-fail, gate-flaky, land-gate, land-gate-retry, land-setup-failed: `plotplot.gate`, and `plotplot.node` present — null on land-level lines).',
  'The fixture line for pleach: {"event":"gate-retry","node":"rules-block","gate":"smoke","time":"2026-09-06T14:03:47.118Z","event.name":"pleach.gate-retry","plotplot.kind":"gate.retry","plotplot.count":1,"plotplot.harness":null,"gen_ai.conversation.id":null,"plotplot.node":"rules-block","plotplot.gate":"smoke"}.',
  'Never present: prompt text, tool output, file content, user names, absolute home paths (the journal already redacts; the envelope adds nothing of that kind).',
].join(' ');

const checks: Check[] = [
  {
    n: 1,
    id: 'je.envelope',
    claim:
      '`envelope` is pure and total: it preserves every input field verbatim, adds `time` (RFC 3339 UTC ending in `Z` from the injected clock), `event.name` = `pleach.<event>`, `plotplot.kind` from the pinned table, `plotplot.count: 1`, `plotplot.harness: null`, `gen_ai.conversation.id: null`; an event name with no pinned kind is a typed throw',
    evidence: 'test/unit/journal-envelope.test.ts',
    needs: [],
    how: [
      "New pure module src/core/journal-envelope.ts (core imports only core). `envelope(event: Record<string, unknown>, now: Date): Record<string, unknown>` — the event's own keys first, verbatim, then the envelope keys. `time` = now.toISOString() (already RFC 3339 UTC with Z). `plotplot.kind` from one exported, exhaustive table KINDS: Record<eventName, kind> covering every event docs/journal.md documents (read it; the table's contents are in the profile summary below) — a name not in the table throws a new typed error in src/core/errors.ts (e.g. JournalEventUnknownError) — never a default kind. Node-scoped and gate mirrors (`plotplot.node`, `plotplot.gate`) are the next check's; keep this one to the universal keys and the kind.",
      PROFILE,
    ].join(' '),
  },
  {
    n: 2,
    id: 'je.fixture',
    claim:
      "The contracts fixture's pleach line (contracts/fixtures/friction.jsonl line 2 at v1.1.0, vendored with provenance) is reproduced key-for-key by `envelope({event:'gate-retry', node:'rules-block', gate:'smoke'}, clock)`: node-scoped lines mirror `plotplot.node`, gate lines mirror `plotplot.gate`, run-level lines carry neither",
    evidence: 'test/unit/journal-envelope-fixture.test.ts',
    needs: ['je.envelope'],
    how: [
      'Add the per-kind required attributes to envelope(): every node.lifecycle, gate.result and gate.retry line mirrors `node` as `plotplot.node` (present and null on a gate.result line that has no node — the land-level gates); gate.result and gate.retry lines mirror `gate` as `plotplot.gate`; run.lifecycle lines carry neither key. Vendor the fixture line VERBATIM into test/fixtures/friction-pleach-line.jsonl with a one-line provenance comment in the test (jahala/plotplot contracts/fixtures/friction.jsonl line 2, tag v1.1.0) and assert envelope(...) with a clock returning that exact time deep-equals JSON.parse(line) — key set AND values.',
      PROFILE,
    ].join(' '),
  },
  {
    n: 3,
    id: 'je.runner',
    claim:
      "`verdict` lines carry `plotplot.runner` (the runner's CLI name, verbatim from `provider`) and `gen_ai.request.model` only when the plan set a model (omitted otherwise, never null); no pleach line ever carries `gen_ai.provider.name`; the existing `provider` and `model` fields are unchanged",
    evidence: 'test/unit/journal-envelope-runner.test.ts',
    needs: ['je.fixture'],
    how: [
      "In envelope(): when the event carries `provider` (today only `verdict` does), add `plotplot.runner` = that string verbatim; when it carries `model`, add `gen_ai.request.model` = that string; never add either otherwise and never add `gen_ai.provider.name` (the umbrella's ruling: claude/codex/gemini/opencode are CLI names, and the provider behind a CLI — Bedrock, Vertex — is not observable from pleach). Assert with a verdict event with and without model, and that a non-verdict event gains neither key.",
      PROFILE,
    ].join(' '),
  },
  {
    n: 4,
    id: 'je.seam',
    claim:
      'The real journal seam writes the envelope on every line it appends and hands the same enveloped line to an in-process narrator; every field the loop appended round-trips through the file; docs/journal.md documents the envelope',
    evidence: 'test/integration/journal-envelope.test.ts',
    needs: ['je.runner'],
    how: [
      "src/seams/journal.ts is the one place lines are emitted (append → JSON line → file; and the narrate callback wired in src/loop/deps.ts / src/faces — read how buildDeps({narrate}) receives events). Wrap the append: line = envelope(event, new Date()) — the seam owns the clock (side effects at the edge) — write it, and hand the SAME enveloped object to the narrator. The in-memory journal in test/loop/harness.ts stays raw (the loop tests assert on loop events, not on the envelope) — do not touch it. Integration test against the real seam in a tmp dir: append several documented events, read the file back, each line parses, carries the envelope keys, and every original field is intact; the narrator saw the enveloped line. Document the envelope in docs/journal.md: a short section under the events table naming the keys, the kinds table's source (the umbrella profile), and that `plotplot.runner` is the runner name (the journal-doc pin test must stay green — add nothing that looks like an undocumented event).",
      PROFILE,
    ].join(' '),
  },
  {
    n: 5,
    id: 'je.pin',
    claim:
      'The stability pin covers kinds: every event documented in docs/journal.md has a pinned `plotplot.kind`, and the kind table names no event the documentation lacks',
    evidence: 'test/unit/journal-doc.test.ts',
    needs: ['je.seam'],
    how: [
      'test/unit/journal-doc.test.ts already pins documented event names ↔ source appends (from the test-phase-commit loop). Extend it in place (a new describe/test block; keep the existing assertions byte-identical): parse the events table in docs/journal.md and assert every event name is a key of KINDS (src/core/journal-envelope.ts) and every KINDS key is documented. This is the RED you write first: it fails if any documented event lacks a kind.',
      PROFILE,
    ].join(' '),
  },
  {
    n: 6,
    id: 'je.e2e',
    claim:
      "Through the real CLI: every line of a real run's journal parses as one JSON object carrying the envelope, `time` ends in `Z`, `gate-retry` lines (if any) carry `plotplot.node` + `plotplot.gate`, and the `verdict` line carries `plotplot.runner`",
    evidence: 'test/e2e/journal-envelope.test.ts',
    needs: ['je.pin'],
    timeoutMs: 2_700_000,
    how: [
      'Model on the e2e tests that read <git-dir>/pleach/journal.jsonl (grep test/e2e for journal.jsonl). Run a small plan through the real CLI (a {command} node needs no runner; a smoke that fails once then passes exercises gate-retry if you want that line — test/loop/gate-retry.test.ts shows the flaky doctrine) and assert over EVERY line of the journal: JSON object, the six universal keys present, time ends in Z, event.name === "pleach." + event, plotplot.kind pinned, the verdict line has plotplot.runner === its provider and no gen_ai.provider.name. This node is the sink of the loop: its audit verifies EVERY check on the page; if a sibling\'s check reads red here, fix it here and say so in Tried.',
      PROFILE,
    ].join(' '),
  },
];

const spec: LoopSpec = {
  loop: 'docs/tend2/journal-envelope.tend2.html',
  payload: 'c9c14db070d3',
  title: "The run journal carries the friction profile's envelope",
  goal: "Every line the run journal writes carries the garden's one event envelope in addition to its own fields: time (UTC, ends in Z), event.name (pleach.<event>), plotplot.kind (a pinned kind), plotplot.count (1), plotplot.harness and gen_ai.conversation.id (present, null — pleach observes the runner, not a harness turn); verdict lines add plotplot.runner (the runner's CLI name, verbatim) and gen_ai.request.model where the plan named a model. gen_ai.provider.name is never written by pleach. Existing event names and documented fields are unchanged.",
  ledger: 'D15',
  sink: 'je.e2e',
  checks,
};

export default spec;
