# Changelog

Notable changes to pleach. Format follows [Keep a Changelog](https://keepachangelog.com). The plan-schema contract keeps its own log at [`docs/contract/CHANGES.md`](docs/contract/CHANGES.md).

Entries carry the defect-ledger id where one exists (`D8`, `D21`, ...); the ledger itself is [`docs/ledger.md`](docs/ledger.md), and every id there maps to a test.

## [Unreleased]

### Fixed
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
