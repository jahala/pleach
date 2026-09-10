# The run journal — pleach's event stream (stable read surface)

Every `pleach run` / `pleach land` appends one JSON line per event to
**`<git-dir>/pleach/journal.jsonl`** (the git dir is resolved through the same
logic as everything else, so linked worktrees work; `--journal PATH` overrides).
The journal is the run's source of truth for observers: tend2's `watch`, the
needs-me union in `next`, and the casting ledger all read it here. The CLI's
stderr narration is a rendering of the same events (`--quiet` silences the
rendering, never the file).

**Stability promise:** event names and the fields documented below are a read
surface other tools build on. Changes are additive — new events and new fields
may appear; documented fields don't change meaning or disappear. Consumers must
tolerate unknown events and unknown fields.

## Events

| event | fields | meaning |
|---|---|---|
| `run-start` | `goal`, `nodes` (count) | a run began |
| `node-start` | `node` | a node's attempt ladder began |
| `gate-fail` | `node`, `gate` (`setup`\|`markers`\|`smoke`\|`red`\|`green`\|`command`\|`audit-parse`\|`commit`\|…) | a gate failed (may retry) |
| `blocked` | `node`, `reason` (the prompt text) | **needs a human** — worker stopped at a permission prompt; session terminated |
| `gate-retry` | `node`, `gate` (`setup`\|`smoke`) | an exec gate went red — one gate-only re-run in the same worktree before the red becomes worker evidence (D10) |
| `gate-flaky` | `node`, `gate` | the retry passed — the red was transient; the node proceeds, no worker re-prompt |
| `phase-commit` | `node`, `phase` (`red`), `sha`, `files` (the sealed set) | the red phase sealed as its own commit the moment the RED gate passed, before the impl prompt was sent — `node/<id>` reads base → red → verified, so the failing-test state is checkoutable (D13) |
| `set-aside` | `node`, `paths` (what was removed, as the worker named it) | collection dropped paths that are not delivery before staging — `.loop-scratch/**`, `.plotplot/friction/**`, anything outside the worktree, anything git ignores. The node stages what remains and proceeds: a set-aside path can never fail it (D14) |
| `audit-egress-unparseable` | `node`, `reaudit` (the bounded attempt), `egress` (the auditor's raw final message, capped 2000 chars) | the audit worker's message did not parse as an `AuditResult` — only the auditor re-runs; the raw message is kept because it is the one artifact that diagnoses an egress failure |
| `verdict` | `node`, `status`, `attempts`, `telemetry` (worker-reported, e.g. `tokens`), `durationMs` (wall clock), `provider` (resolved — never absent), `model?`, `gate?` (`ran`, `exitCode`, `outputTail?` — the failing gate's actual output, capped 2000 chars), `blockedReason?`, `paneTail?`/`processExit?` (what the runner saw at an abnormal end, when it could see anything — D11) | a node reached its terminal verdict |
| `closed` | `node`, `sha`, `degraded?` (string[] — only when non-empty) | verified close — `node/<id>` published at `sha`; `degraded` lists checks the plan never configured (`smoke:unconfigured`, `audit:unconfigured`): no coverage is not coverage, visible at close time |
| `not-closed` | `node` | ledger declined to verify-close (branch published, not verified) |
| `quarantined` | `node`, `branch` (`quarantine/<id>`), `sha` | failed OR blocked work preserved for inspection (D11 — unfinished is not wrong) |
| `quarantine-failed` | `node`, `detail` | evidence preservation itself failed |
| `receipt` | `node`, `sha256`, `derived` (`publishable`\|`quarantined`), `degraded` (string[]) | a sealed close receipt was minted at settle (§D) — facts frozen at classify time, hash pinned as a `receipt-sha256:` trailer in the node/quarantine commit, file at `<git-dir>/pleach/receipts/<node>.json`; verify with `pleach receipt <node>` |
| `gate-artifact` | `node`, `gate` (`smoke`, `friction`), `path`, `sha256` | something the worktree held was kept beside the receipt before it was disposed (D14). `smoke`: the gate's stdout when it parses as a SARIF 2.1.0 log, at `<git-dir>/pleach/receipts/<node>.sarif`, and `sha256` is the sealed `gates[].artifactSha` — one hash, cited by the receipt and answered by the file. `friction`: the tree's own friction journal (`.plotplot/friction/<yyyy-mm>.jsonl`, months in name order), at `<node>.friction.jsonl`; no gate produced it, so `sha256` is over the bytes kept |
| `receipt-write-failed` | `node`, `detail` | the receipt file, or one of the artifacts kept beside it, could not be written (the trailer is still pinned in git; the close stands) |
| `acceptance-changed` | `node`, `recorded` (`{smoke?, audit?}`), `current` (same shape) | a ledger-closed node's receipt records a different acceptance than the current plan — the old verification proves nothing about the new gate, so the node re-dispatches instead of skip-trusting |
| `acceptance-cascade` | `node`, `via` (the invalidated dependency) | a closed dependent of a re-dispatched node rebuilds too — its close embedded the OLD ancestor, and only sinks land, so skip-trusting it would silently keep the re-verified work off the target branch |
| `rebuild-required` | `node` | a verified branch moved since close — refusing to trust it |
| `sha-mismatch` | `node`, `recordedSha`, `foundSha` | ledger SHA disagrees with the branch |
| `dispose-failed` | `node`, `detail` | worktree cleanup failure (diagnostic) |
| `run-end` | the `RunSummary` fields (`closed`, `failed`, `partial`, `skipped`, `blocked`, `aborted`, `quarantined`, `alreadyVerified`, …) | the run settled — `aborted` names the nodes the run's own signal cut off mid-wait (D16): settled with `status: "aborted"`, receipt written, tree quarantined, never counted as failures |
| `run-aborted` | — | SIGINT/SIGTERM teardown (D12): no new launches; in-flight waits interrupted, their nodes settle with evidence; `run-end` still follows |
| `run-stopped` | — | `pleach stop` drained the run (D16): the marker beside the run's lock is read in the same tick as every launch decision, so nothing further launched; in-flight nodes settled normally and kept their work, the marker is consumed, and the nodes that never started are `skipped` in the `run-end` that follows |
| `land-start` | `goal` | landing began |
| `land-setup` | `commands[]` | stack provisioning: the sinks' deduped setup commands run in the gate worktree before their smokes (D9 — a fresh stack has no environment) |
| `land-setup-failed` | `command`, `exitCode`, `outputTail` | provisioning failed — an ENVIRONMENT refusal, never a composition culprit; the bisect does not run |
| `land-gate` | `commands[]`, `sinks[]` | the composition gate: sinks' deduped smokes run on the stack tip |
| `land-gate-retry` | `command` | one flaky retry of the failing gate command |
| `land-bisect` | `testing[]`, `context[]` | bisect probe: testing these sinks atop the known-good context |
| `land-culprit` | `node`, `command`, `outputTail` | the sink whose inclusion breaks the composition (refuse-all — diagnostic only) |
| `land-integrity-failed` | `command`, `outputTail` | culprit-free subset also failed — diagnosis untrusted, nothing lands |
| `land-blocked` | `reason` or `unverified` (ids) | landing refused — nothing touched |
| `land-conflict` | `ref`, `files` | merge conflict — repository left untouched |
| `landed` | landing result fields | verified sinks merged onto the checked-out branch |

## The envelope

Every line carries the garden's one event envelope beside its own fields, so
tend2 reads this journal, the friction journal and mull's spend log with one
loader (ledger D15). The envelope is `contracts/friction-profile.md` at
jahala/plotplot (v1.1.0), which is also where the kinds below are pinned.

| key | value |
|---|---|
| `time` | when the line was written — RFC 3339 UTC, ending in `Z` |
| `event.name` | the event's name, source-namespaced: `pleach.` + the name in the table above. The line keeps its own `event` field too |
| `plotplot.kind` | one of four pinned kinds (below) |
| `plotplot.count` | `1` — pleach writes one line per event and never batches |
| `plotplot.harness` | `null` on every pleach line: pleach observes a runner's process, not a harness turn |
| `gen_ai.conversation.id` | `null` on every pleach line: a run is not one conversation |

The four kinds, the lines each covers, and the scope each mirrors under the
profile's names:

| kind | lines | mirrors |
|---|---|---|
| `run.lifecycle` | the run and the landing, beginning to end: `run-start`, `run-end`, `run-aborted`, `run-stopped`, `land-start`, `land-setup`, `land-bisect`, `land-culprit`, `land-integrity-failed`, `land-blocked`, `land-conflict`, `landed` | — |
| `node.lifecycle` | one node's passage, and every record kept or refused along the way: `node-start`, `blocked`, `phase-commit`, `set-aside`, `audit-egress-unparseable`, `verdict`, `closed`, `not-closed`, `quarantined`, `quarantine-failed`, `receipt`, `gate-artifact`, `receipt-write-failed`, `acceptance-changed`, `acceptance-cascade`, `rebuild-required`, `sha-mismatch`, `dispose-failed` | `plotplot.node` |
| `gate.result` | a gate said yes or no: `gate-fail`, `gate-flaky`, `land-gate`, `land-gate-retry`, `land-setup-failed` | `plotplot.gate`, `plotplot.node` (`null` on land-level lines, which belong to no node) |
| `gate.retry` | an exec gate's one same-tree re-run: `gate-retry` | `plotplot.node`, `plotplot.gate` |

Terminal-verdict lines add who ran the work: `plotplot.runner` is the runner's
CLI name, verbatim from the line's `provider` field, and `gen_ai.request.model`
is the model where the plan pinned one (absent otherwise — "never told us" is a
missing key, not a `null`). `gen_ai.provider.name` is never written: a runner
can be routed through Bedrock or Vertex, and pleach cannot see which.

The envelope is additive. Every event name and field documented above means
what it always meant, and consumers that ignore the envelope keys read the
journal exactly as before.

## Reading it

- **Liveness**: the file is append-only during a run; tail it. A `blocked` event
  with no later `verdict` for that node means a human is needed *now*.
- **Cost**: `verdict` events carry `telemetry` (worker-reported tokens where the
  runner knows them), `durationMs`, and `attempts`. Aggregate
  cost-per-verified-claim = spend on the path that ended in `closed`, divided by
  claims closed.
- **Library callers**: `buildDeps({ narrate })` receives every event after its
  durable append — same stream, in-process.
