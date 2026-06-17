# Changelog

Notable changes to pleach. Format follows [Keep a Changelog](https://keepachangelog.com). The plan-schema contract keeps its own log at [`docs/contract/CHANGES.md`](docs/contract/CHANGES.md).

## [Unreleased]

### Added
- The deterministic conductor: a Kahn-scheduled DAG runner with a per-node gate ladder (isolate -> setup -> work -> conflict-marker scan -> scoped stage -> smoke -> cross-provider audit -> commit-before-emit) that publishes a `node/<id>` branch only for verified work.
- Six seams — rctrl, tend, isolate, exec, lock, journal — behind a pure, total `core/`.
- `pleach run` and `pleach validate` CLI faces with typed exit codes.
- The P6 proof run: a full tend -> pleach -> verified close driven by real agents (claude builds, codex audits, tend verifies).
- A self-tracking tend garden (`docs/tend/`) and a GitHub Pages landing page.
- The `@agent-contract/plan` schema, pinned byte-for-byte to `core/plan.ts` by a drift test.
