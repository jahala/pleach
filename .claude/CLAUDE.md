# pleach — working in this repo

**What this is.** pleach is a **standalone deterministic conductor** for verified agent work. It
consumes a `Plan` — a DAG of nodes — isolates each node in a detached git worktree merged from its
dependencies' verified branches, enforces **gates** (setup · conflict-marker scan · smoke · cross-provider
audit), and publishes a `node/<id>` branch **only for verified work**, so garbage can't propagate down the
DAG. It runs on **git + any agent runner**; **tend** (the feature ledger) and **umbel** (the agent-worker
boundary) are the batteries-included reference adapters, not requirements (see [`docs/adapters.md`](../docs/adapters.md)).
**The prime invariant: agents produce; code decides** — every canonical decision (close, verify,
quarantine, retry) is deterministic code; agent output is parsed evidence, never interpreted.

**Read before substantial work:** [`ENGINEERING.md`](../ENGINEERING.md) is the binding doctrine. Also
[`README.md`](../README.md) (what + status), [`docs/contract/plan-schema.md`](../docs/contract/plan-schema.md)
(the `@agent-contract/plan` schema — this repo is its home), and [`docs/ledger.md`](../docs/ledger.md)
(the verified defect ledger; every test maps to a ledger item).

## How agents work here (non-negotiables — full detail in ENGINEERING.md)

- **Test-first.** No fix or feature without a failing test first; every defect-ledger item lands RED before
  its fix. If you can't write the failing test, you don't understand the change yet.
- **No stubs, mocks, or TODOs in committed code.** (The in-memory seams used in loop tests are *real*
  implementations of the seam interfaces, not behavior-mocks — see ENGINEERING.md's testing doctrine.)
- **S.U.P.E.R., strict downward deps.** `core/` is pure & total and imports nothing else; `seams/`, `adapters/`
  + `faces/` own all I/O; `loop/` composes the injected seams + adapters it was *given* (never imports them
  directly). A face never calls git; the loop never spawns a process; a seam/adapter never makes a scheduling decision.
- **Typed errors, caught at the face.** Discriminated `Error` subclasses in `core/errors.ts`; `faces/` map
  them to exit codes. No bare `new Error` outside `core/errors.ts`.
- **Single schema source.** `core/plan.ts` is the only Plan/Node/Verdict/AuditResult definition, pinned
  byte-for-byte to `docs/contract/plan-schema.md` by a drift test. Derive types via `z.infer`; never
  hand-declare them. A schema change = doc + source + drift-test + `docs/contract/CHANGES.md` in ONE commit.
- **Smallest reasonable change**; match surrounding style; no speculative abstraction; no back-compat shims
  (this is greenfield). Never `rm` — use `trash`.
- **Green before merge:** `bun run check` = `tsc --noEmit` + `biome check` + `bun test`. Must be green.

## Architecture

```
faces/     cli.ts                                  ← argv, exit codes, stdout/stderr discipline
loop/      run-plan · run-node · run-work          ← the deterministic loop; composes injected seams + adapters
adapters/  umbel · tend · git                      ← pluggable tool bridges (the runner + ledger ports)
seams/     isolate · exec · lock · journal         ← pleach's own I/O, thin
core/      plan · validate · classify · errors     ← pure, total
```

Stack: Bun + `bun:test`, TypeScript strict, `zod` the only dependency, `biome`. Runtime substrate:
`git ≥ 2.38` always; the default umbel runner additionally needs `tmux` + the `umbel` binary; a `tend` transport is optional (the bundled gitLedger needs neither).

## Track work in tend (this repo dogfoods itself)

tend tracks planned work across sessions in a garden at `docs/tend/` (dashboard: `index.html`). If it's not
updated, the next session starts blind.

- **`/tend`** — see status + what's unblocked. The chain: `/tend position` (personas + jobs) →
  `/tend brainstorm` (slots + checks) → `/tend plan` (testable steps) → `/tend run` (build) → `/tend audit`
  (verify with real evidence). Also `/tend discover` (map existing code), `/tend change` (requirements
  shift), `/tend narrate` (article body + diagrams).
- **Before multi-file work,** check tend first (`tend_get_unblocked` or `ls docs/tend/features/`). A match →
  update the touched step's status via `tend_update_feature` (object arrays merge by-id). No match →
  `/tend brainstorm` a minimal feature.
- **MCP tools:** `tend_get_context` (full feature in one call) · `tend_get_unblocked` · `tend_get_gaps`
  (each gap names its closing skill) · `tend_update_feature` (single write surface). Single-feature reads go
  through the polyglot: `bash docs/tend/<id>.tend.html data | jq` — never parse a `.tend.html` as text.

## Gotchas

- **`/tend audit` is the only path to `status: verified`, and it's strict:** a `pass` needs a real test
  that runs green *and* **discriminates** — the `negctrl` helper mutates the source in a throwaway worktree
  and the test must then fail. A check's `validates_job` should point at the job its test actually asserts:
  seam/component tests → `developer:1`; operator end-to-end guarantees verify at the loop / CLI / proof-run
  layer. (Current, after the 2026-06-18 adapters refactor + garden sync: the umbel/tend features were reframed
  as adapters and `pluggable-adapters` was added; `cli-validate` / `conductor-loop` / `lock-journal` are now
  **verified-but-stale** — the refactor moved/changed their cited evidence, behavior is green at 191/13/0, a
  `/tend audit` refresh is pending; `cli-run` / `umbel-seam` / `tend-seam` / `pluggable-adapters` are planned/partial.)
- **tend#47 (upstream, filed):** the operator/developer persona polyglots validate as invalid — the
  catalog→snapshot mirror writes `journey_phases` the schema forbids, and the served tend dist is stale.
  Persona narrative writes are blocked until it's fixed + the missoula dist rebuilt + the tend MCP
  restarted. Don't "fix" it by reverting persona content.
- **`.mcp.json`** wires the tend MCP server to a local missoula checkout (machine-specific absolute path);
  it's gitignored.
