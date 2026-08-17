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
| `verdict` | `node`, `status`, `attempts`, `evidence`, `telemetry` | a node reached its terminal verdict |
| `closed` | `node`, `sha` | verified close — `node/<id>` published at `sha` |
| `not-closed` | `node` | ledger declined to verify-close (branch published, not verified) |
| `quarantined` | `node`, `branch` (`quarantine/<id>`), `sha` | failed work preserved for inspection |
| `quarantine-failed` | `node`, `detail` | evidence preservation itself failed |
| `rebuild-required` | `node` | a verified branch moved since close — refusing to trust it |
| `sha-mismatch` | `node`, `recordedSha`, `foundSha` | ledger SHA disagrees with the branch |
| `dispose-failed` | `node`, `detail` | worktree cleanup failure (diagnostic) |
| `run-end` | the `RunSummary` fields (`closed`, `failed`, `partial`, `skipped`, `blocked`, `quarantined`, `alreadyVerified`, …) | the run settled |
| `land-start` | `goal` | landing began |
| `land-blocked` | `reason` or `unverified` (ids) | landing refused — nothing touched |
| `land-conflict` | `ref`, `files` | merge conflict — repository left untouched |
| `landed` | landing result fields | verified sinks merged onto the checked-out branch |

## Reading it

- **Liveness**: the file is append-only during a run; tail it. A `blocked` event
  with no later `verdict` for that node means a human is needed *now*.
- **Cost**: `verdict` events carry `telemetry` (worker-reported tokens where the
  runner knows them) and `attempts`; duration fields are additive-planned (see
  CHANGES). Aggregate cost-per-verified-claim = spend on the path that ended in
  `closed`, divided by claims closed.
- **Library callers**: `buildDeps({ narrate })` receives every event after its
  durable append — same stream, in-process.
