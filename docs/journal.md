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
| `audit-egress-unparseable` | `node`, `reaudit` (the bounded attempt), `egress` (the auditor's raw final message, capped 2000 chars) | the audit worker's message did not parse as an `AuditResult` — only the auditor re-runs; the raw message is kept because it is the one artifact that diagnoses an egress failure |
| `verdict` | `node`, `status`, `attempts`, `telemetry` (worker-reported, e.g. `tokens`), `durationMs` (wall clock), `provider` (resolved — never absent), `model?`, `gate?` (`ran`, `exitCode`, `outputTail?` — the failing gate's actual output, capped 2000 chars), `blockedReason?`, `paneTail?`/`processExit?` (what the runner saw at an abnormal end, when it could see anything — D11) | a node reached its terminal verdict |
| `closed` | `node`, `sha`, `degraded?` (string[] — only when non-empty) | verified close — `node/<id>` published at `sha`; `degraded` lists checks the plan never configured (`smoke:unconfigured`, `audit:unconfigured`): no coverage is not coverage, visible at close time |
| `not-closed` | `node` | ledger declined to verify-close (branch published, not verified) |
| `quarantined` | `node`, `branch` (`quarantine/<id>`), `sha` | failed OR blocked work preserved for inspection (D11 — unfinished is not wrong) |
| `quarantine-failed` | `node`, `detail` | evidence preservation itself failed |
| `receipt` | `node`, `sha256`, `derived` (`publishable`\|`quarantined`), `degraded` (string[]) | a sealed close receipt was minted at settle (§D) — facts frozen at classify time, hash pinned as a `receipt-sha256:` trailer in the node/quarantine commit, file at `<git-dir>/pleach/receipts/<node>.json`; verify with `pleach receipt <node>` |
| `receipt-write-failed` | `node`, `detail` | the receipt file could not be written (the trailer is still pinned in git; the close stands) |
| `acceptance-changed` | `node`, `recorded` (`{smoke?, audit?}`), `current` (same shape) | a ledger-closed node's receipt records a different acceptance than the current plan — the old verification proves nothing about the new gate, so the node re-dispatches instead of skip-trusting |
| `acceptance-cascade` | `node`, `via` (the invalidated dependency) | a closed dependent of a re-dispatched node rebuilds too — its close embedded the OLD ancestor, and only sinks land, so skip-trusting it would silently keep the re-verified work off the target branch |
| `rebuild-required` | `node` | a verified branch moved since close — refusing to trust it |
| `sha-mismatch` | `node`, `recordedSha`, `foundSha` | ledger SHA disagrees with the branch |
| `dispose-failed` | `node`, `detail` | worktree cleanup failure (diagnostic) |
| `run-end` | the `RunSummary` fields (`closed`, `failed`, `partial`, `skipped`, `blocked`, `quarantined`, `alreadyVerified`, …) | the run settled |
| `run-aborted` | — | SIGINT/SIGTERM teardown (D12): no new launches; in-flight waits interrupted, their nodes settle with evidence; `run-end` still follows |
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

## Reading it

- **Liveness**: the file is append-only during a run; tail it. A `blocked` event
  with no later `verdict` for that node means a human is needed *now*.
- **Cost**: `verdict` events carry `telemetry` (worker-reported tokens where the
  runner knows them), `durationMs`, and `attempts`. Aggregate
  cost-per-verified-claim = spend on the path that ended in `closed`, divided by
  claims closed.
- **Library callers**: `buildDeps({ narrate })` receives every event after its
  durable append — same stream, in-process.
