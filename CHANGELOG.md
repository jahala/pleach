# Changelog

Notable changes to pleach. Format follows [Keep a Changelog](https://keepachangelog.com). The plan-schema contract keeps its own log at [`docs/contract/CHANGES.md`](docs/contract/CHANGES.md).

Entries carry the defect-ledger id where one exists (`D8`, `D21`, ...); the ledger itself is [`docs/ledger.md`](docs/ledger.md), and every id there maps to a test.

## [Unreleased]

### Added
- `pleach clean` reaps the worker sessions a killed run left alive: the journal names every session the loop spawned and killed, and clean ends each one spawned and never killed, through the runner. `--dry-run` lists what it would do (D43).
- Every verdict that is not `done` carries a `reason` and a `nextStep` on its journal line, and the run log prints both (D41).
- Secret redaction: everything pleach writes from agents or gates goes through `plotplot redact` first. `run`, `land` and `audit` refuse to start without `plotplot` (install: `cargo install --locked --git https://github.com/jahala/plotplot`); `--no-redact` opts out explicitly and is recorded on every run and receipt (D37).
- Named casts in `pleach.config.ts`: a node names a cast (provider, model and environment) as its provider, so one plan can reach two endpoints of one CLI, such as Claude by subscription and DeepSeek through Claude Code. `validate` and `run` refuse a provider name that is neither the runner's nor a cast's, and `run` refuses a cast whose variable is unset before it starts (D36).
- `--provider-backoff-ms` and `--settle-ms` (or `$PLEACH_SETTLE_MS`) on `pleach run` (D34, D35).
- `pleach status <plan>` and `pleach wait <plan>`: a run's state read from its journal, so a conductor stops polling the log. `wait` blocks until the run (or `--node`) settles and exits 0 when everything is closed or was already verified, 1 otherwise, 124 on `--timeout` (D31).
- `pleach audit-wrap -- <check>` turns any check into the `tend-audit-result` block an audit command must print (D33).

### Fixed
- A close keeps a handback even when the runner could not read the worker's final message: it names the failure, and the journal says `handback-read-failed`. An empty final message is named too (D42).
- The plan schema's canonical text is v1.1.6. Five edits had gone in under v1.1.5; a test now fails when the text changes without its version line (D44). `pleach receipt` still verifies receipts minted under v1.1.5: the contract follows semantic versioning, and the version check compares only the major version (D46).
- A node that fails before its tree is usable no longer reports a catastrophic isolate failure (fixed by D22; pinned by regression tests, D45).
- A commit you add on top of a blocked node's `quarantine/<id>` is kept when the next run resumes it (D38).
- `pleach audit` re-audits again once the plan's audit command has changed (D39).
- A worker whose provider needs a person to sign in settles blocked at once, or moves to `--fallback-provider`, instead of retrying into the sign-in screen (D40).
- A provider or network error waits and runs again inside the same attempt, so a short outage no longer burns a node's attempts; once the waits are spent the verdict names the cause (D34).
- Gates wait until a worker's tree has stopped changing, so a background command still writing is no longer judged half-done (D35).
- Worker environment values reach umbel by name only, never on the command line where `ps` shows them (#126, D36).
- A failed gate's writes to the tree are rewound before the retry, so a retry no longer inherits them and a verified branch no longer carries marks the admitting gate disproved (D32).
- A relative `--config` path is read from the folder you run pleach in. It used to be looked up in pleach's own source folder, so the run failed before any node started (D30).
- The docs say how a repo makes the `pleach/*` imports in `pleach.config.ts` resolve: `bun add -d github:jahala/pleach`. Running pleach through `bunx` alone does not (D29).
- `pleach land` reports a merge that git refuses without a conflict, usually a repository hook declining the merge commit, as a refusal with git's own words. It used to report a conflict naming no files (D28).
- Nodes that start together no longer race into their worktrees: a node could fail at `isolate` with no tree and no reason when a sibling's `git worktree add` was half-written (D27).
- The verified commit holds exactly the tree its gates judged. A git hook that changes the commit (a formatter rewriting a file, or a hook staging its own) now fails the node under the `commit` gate, keeps the tree on `quarantine/<id>` and publishes nothing. Before, the changed commit was published as verified. Hooks still run and may still refuse (D24).

### Changed
- CI runs the suites that drive the real umbel binary, against a pinned umbel commit on every push and against umbel's default branch weekly. It installs with `--frozen-lockfile`. On CI the canary fails when it cannot resolve tend2, where it used to skip and report green (D25).
- The architecture rules in ENGINEERING.md are a test. `pleach <unknown-verb>` names the verb as unknown even with no plan path after it (D26).

### Removed
- The retired tend v1 skills under `.claude/skills/tend*`. tend v1 is sunset upstream; `pleach-plan` is the one skill this repository ships.

## [1.0.0] - 2026-09-20

### Added
- The deterministic conductor: a Kahn-scheduled DAG runner with a per-node gate ladder (isolate -> setup -> work -> conflict-marker scan -> scoped stage -> smoke -> cross-provider audit -> commit-before-emit) that publishes a `node/<id>` branch only for verified work.
- Seven seams — exec, isolate, lock, journal, receipts, clean, gitdir — and two adapter ports (runner, ledger) behind a pure, total `core/`.
- The `@agent-contract/plan` schema, pinned byte-for-byte to `core/plan.ts` by a drift test.
- The `pleach` CLI: eight verbs (`run`, `land`, `audit`, `stop`, `validate`, `schema`, `receipt`, `clean`) with typed exit codes (0 all closed, 1 failures, 2 usage or invalid plan, 3 lock held).
- `pleach land`: merges a verified plan's sinks onto the checked-out branch behind a composition gate that verifies, bisects and refuses all. `--sinks` lands a named subset; `--land-gate CMD` runs on the composed stack before the publish, with `{base}` replaced by the target branch's tip as it stood before the merges. Landing reads the ledger and does not wait on the rest of the run (D18).
- `pleach receipt`: close receipts and the honesty ledger — every settled node's verdict is hashed and re-checkable after the fact.
- `pleach stop`: drains a run so nothing new launches and in-flight nodes settle; `--now` aborts them instead. `pleach clean` sweeps a killed run's stale locks and orphaned worktrees (D12).
- `pleach audit`: re-runs only the cross-provider audit on a quarantined node whose build was green, so a bad relay costs one auditor turn rather than the node.
- `pleach schema` emits the plan contract as JSON Schema for planners and codegen.
- The hygiene gate: a secrets-and-junk battery over the staged diff, before anything is published.
- The red phase is its own commit, so a phased node's test-first step is visible in history (D13).
- Gate artifacts survive settle: the smoke gate's SARIF and the worktree's friction journal are kept rather than discarded with the tree (D14), and the run journal carries the friction profile's envelope (D15).
- A halted run keeps the work it was holding: `--idle-ms` ends a wedged worker's wait, the node settles blocked, and its tree is kept on `quarantine/<id>` (D16). Nothing a worker produced is lost (D17), and a pending node resumes from its quarantine on the next run unless `--fresh` refuses the seed.
- A fault in the plan is refused before a worker costs anything: `validate` and `run` both reject a command string holding a bare shell operator, naming the node, the field and the `bash -lc` escape hatch (D19).
- The record survives what the repository does: a receipt with no verdict line is journaled as `journal-gap` at run start, and each run copies its own journal lines beside the receipts at run end (D21).
- `--fallback-provider`: an attempt that comes back dead is an outage, not a red gate, so the node is re-cast on another provider with the audit diversity rule re-checked.
- A worker that writes `BLOCKED.md` has finished and is not asked again; the file's text becomes the verdict's `blockedReason`.
- Pluggable adapters: `direct-cli` (headless `claude -p` / `codex exec`, no umbel and no tmux) and `scripted` beside the default umbel runner; `gitLedger` makes a standalone run need no external ledger.
- The `pleach-plan` Claude Code skill ships with the package.
- `pleach --version`.

### Changed
- Workers spawn unattended by default; safety is external (disposable worktree, gates, cross-provider audit) rather than a permission prompt.
- The garden moved to tend2's format as self-contained pages under `docs/tend2/`; `docs/tend/` is frozen v1 history. Upstream tend v1 is sunset, and the tend ledger is now opt-in via `--tend-module`.
- The runner seam was renamed rctrl -> umbel throughout.

### Fixed
- A seam's surprise never costs the tree (D23).
- The git dir resolves absolutely whatever shape the repo root was given in (D22).
- No terminal verdict without an artifact (D11).
- A gate-only retry before red is evidence, and a gate that produced no output is marked as such (D10).
- `pleach --help` exited 2 as though it were an unknown flag (D8).
- `land` provisions its gate stack: the sinks' setup union runs before their smokes (D9).
- The umbel adapter probes session existence after a spawn, so a spawn that produced no session fails fast instead of waiting.

## Earlier

- The P6 proof run: a full tend -> pleach -> verified close driven by real agents (claude builds, codex audits, tend verifies).
