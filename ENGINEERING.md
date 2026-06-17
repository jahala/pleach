# pleach — Engineering Doctrine

Every agent working in this repo reads this file FIRST and conforms to it. Prompts that spawn agents must
reference this file by path. Deviations require a written reason in the PR description.

## What pleach is

pleach is the **deterministic conductor** between tend (the feature ledger that decides what "done"
means) and rctrl (the execution boundary that runs one unit of agent work reliably). It consumes a
`Plan` (a DAG of nodes), runs each node's work in an **isolated detached git worktree** merged from its
dependencies' verified branches, enforces **gates** (smoke commands, conflict-marker checks,
cross-provider audits), emits typed `Verdict`s to tend's deterministic ingester, and **publishes a
`node/<id>` branch only for verified work** — so garbage cannot propagate down the DAG.

```
tend     decides what the garden should bear   (ledger of intent; the verified gate)
pleach   interweaves the branches               (this repo — deterministic loop, no agent judgment)
rctrl    holds each grower steady               (spawn/send/wait/read/kill over tmux)
agents   the plants                             (stochastic; claude/codex/gemini/opencode)
git+tmux the soil
```

**The prime invariant: agents produce; code decides.** Every canonical decision — close, verify, merge,
retry, status — is deterministic code. Agent output is *report material* (diffs, messages, audit JSON),
parsed and validated, never interpreted. If you find yourself letting an agent's prose decide a branch
of control flow, stop: that's the exact hole this system exists to close.

Authoritative context (read before substantial work):
- `docs/plan.md` — the build plan and work breakdown.
- `docs/contract/plan-schema.md` — the canonical `@agent-contract/plan` v1.1 text (this repo is its home).
- `docs/ledger.md` — the verified defect ledger this design answers. Every ledger ID maps to a required test.

## Non-negotiables

1. **Test first.** No fix or feature without a failing test that demonstrates the need. Every defect-ledger
   item lands as a RED test before its fix. If you can't write the failing test, you don't understand the
   defect yet.
2. **No stubs, no mocks, no TODOs in committed code.** Test doubles policy is precise — see Testing
   doctrine below. Committed `// TODO` or half-implementations are rejected at review.
3. **S.U.P.E.R.**
   - **S**ide effects at the edge — I/O lives in `seams/` and `faces/`; `core/` computes; `loop/` composes
     seams it was *given*.
   - **U**ncoupled logic — dependencies are parameters. A function's signature is its complete contract.
   - **P**ure & total — `core/` functions are deterministic and handle every input; failure is in the
     return type or a typed throw, never a surprise.
   - **E**xplicit data flow — linear pipelines; no mutation chains; no module-level mutable state.
   - **R**eplaceable by value — any `core/` call can be swapped for its return value.
4. **Throw typed errors, catch at the face.** Discriminated `Error` subclasses in `src/core/errors.ts`;
   `faces/` maps them to exit codes. No `Result<T,E>` library. No bare `new Error` outside `core/errors.ts`.
5. **Single schema source.** `src/core/plan.ts` is the only definition of Plan/Node/Verdict/AuditResult;
   the drift test pins it byte-for-byte to `docs/contract/plan-schema.md`. CLI args and any future faces
   derive from the same zod objects via `z.infer` — never re-declare types by hand.
6. **Smallest reasonable change.** Match surrounding style. No speculative abstraction. No
   backwards-compatibility shims — this is greenfield; there is nothing to be compatible with.
7. **Never `rm`** — use `trash` for interactive deletion. Programmatic cleanup of paths *this code
   created* (worktrees, tmp dirs) uses git's own commands or `fs.rm` on paths we provably own.

## Architecture — strict downward dependencies

```
faces/     cli.ts                                          ← argv, exit codes, stdout/stderr discipline
loop/      run-plan.ts  run-node.ts  run-work.ts           ← the deterministic loop; composes injected seams + adapters
adapters/  rctrl.ts  tend.ts  git.ts                       ← pluggable tool bridges (the runner + ledger ports)
seams/     isolate.ts  exec.ts  lock.ts  journal.ts        ← pleach's own I/O, thin
core/      plan.ts  validate.ts  classify.ts  evidence.ts  errors.ts   ← pure, total
```

- `core/` imports nothing from the other layers. `seams/` and `adapters/` import `core/`; an `adapters/`
  bridge may also use a `seam/` (e.g. the audited `exec`). `loop/` imports `core/` types and receives seam +
  adapter *instances* as a `Deps` parameter (never imports those modules directly — construction happens in
  `faces/`). `faces/` wires everything.
- **Nothing reaches across layers.** A face never calls git; the loop never spawns a process; a seam
  never makes a scheduling decision.

## Stack

- TypeScript strict (`strict: true`; `exactOptionalPropertyTypes` OFF — it breeds conditional-spread
  noise for zero safety here). ES modules, `.ts` extensions in imports.
- Bun runtime + `bun:test`. Node-compatible source (no Bun-only APIs in `core/`).
- Dependencies: `zod` only, until a need is proven in a PR description. No native modules.
- `biome` for lint/format; `bun run check` = typecheck + lint + test and must be green before any merge.
- Substrate requirements (runtime, not dev): `git ≥ 2.38`, `tmux`, the `rctrl` binary, `tend` (transport
  per the T1 decision).

## The contract

This repo is the **canonical home** of `@agent-contract/plan` v1.1. The schema text lives in
`docs/contract/plan-schema.md`; `src/core/plan.ts` must match it byte-for-byte inside the fenced block
(drift test enforces; same pattern tend uses). tend and rctrl vendor from the doc. Changing the schema =
changing the doc + the source + the drift test in ONE commit, with a version note — and a heads-up
recorded in `docs/contract/CHANGES.md` for the other two repos.

## Error taxonomy (the classify ladder — `core/classify.ts`)

| Source | kind | Action |
|---|---|---|
| worker `reason: 'dead'` | `dead` | `onDead:'resume'` → dispose + re-isolate + fresh worker, else fail |
| worker `reason: 'timeout'` / exec timeout | `retryable` | retry ≤ `maxAttempts`, **reuse tree, re-prompt with evidence** |
| worker `reason: 'input' \| 'idle'` | `blocked` | kill worker; Verdict `status:'blocked'`; no auto-retry (human attaches) |
| smoke / command non-zero, marker-gate hit | `retryable` | retry ≤ `maxAttempts`, reuse tree, evidence in re-prompt |
| audit returned fail verdicts | `retryable` | re-prompt the *builder* with the audit `reasons[]` |
| `AuditParseError` (bad audit egress) | `reaudit` | re-run **only the audit worker**, bounded separately (default 2) |
| `aborted` / lockfile held / plan invalid | `terminal` | fail fast, no retry |
| unknown error | `terminal` | fail loudly — never default-retry what we can't name |

**Retries always carry evidence.** A re-prompt without the failure's evidence (smoke output tail, audit
reasons, conflict-file list) is a bug, not a retry.

## Concurrency & state invariants

- **One conductor per (repo, source):** `O_EXCL` lockfile with pid; refuse to start if live, replace if
  stale. Test it.
- **Single ingester:** all `TendSeam` calls flow through one in-process serial queue, even with parallel
  nodes finishing.
- **Commit before emit:** the `node/<id>` branch + SHA exist *before* tend is told `verified`. The
  durable claim is never made without the artifact.
- **Closed-then-dispose ordering:** `closed.set(id, sha)` and `dispose()` both complete inside the node's
  inflight promise — a dependent can never isolate against a still-live worktree.
- **baseRef resolution chain:** `node/<id>` branch → recorded SHA from `readClosed` → typed error
  ("rebuild required"). Never silently fall back to HEAD.
- **Startup reconciliation:** every closed id must resolve to a commit before the loop starts.
- **Defensive copies:** never mutate what a seam returned.
- **Trust boundary (declared):** Plans are trusted input. Even so: `exec` is arg-array only (no `sh -c`
  string interpolation anywhere), `Node.id` charset is schema-enforced, and tend state is read only from
  paths **outside** any worker-writable worktree. SHAs of refs pleach created are verified before use —
  a worker can reach shared git refs from inside a worktree; never trust a ref it could have moved.

## Testing doctrine

Output must be pristine to pass — no stray logs, no unhandled-rejection noise. Kill hung runners; never
raise a timeout to "fix" a flake — find the race.

- **Unit (`test/unit`)** — `core/` only. Pure in/out. No fs, no git, no processes.
- **Integration (`test/integration`)** — seams against the REAL substrate: real git repos in tmp dirs
  (isolate, lock), real processes (exec), real `rctrl` binary driving its **fake worker binaries**
  (the `fake-claude.sh` pattern vendored in `test/fixtures/`), real `tend` in a tmp garden.
- **Loop tests (`test/loop`)** — `runPlan`/`runNode` with **in-memory seam implementations**. These are
  real, complete implementations of the seam interfaces (deterministic worker, in-memory ledger), not
  mocks of behavior under test — the subject is the *loop's* scheduling/retry/close logic. Anything that
  asserts on a seam internal belongs in integration instead.
- **E2E (`test/e2e`)** — `pleach run` as a process, real git + real rctrl + fake worker binaries +
  real tend transport. **No mocks. Ever.**
- **Proof (`test/proof`, gated `PLEACH_PROOF=1`)** — real claude builds / real codex audits on the
  examples project. Burns subscription; never in CI.
- **The ledger is the test plan.** `docs/ledger.md` items (A1–A3, B1–B4, C1–C5, D1–D7, SEC1–3, M1–M3)
  each map to at least one named test (`// ledger: B2` comment at the test). The §6 cases from the bridge
  spec (fan-out, join-conflict, concurrency invariant, commit-on-verified, dead-retry-re-isolates,
  phase gates, ingester derivation) are all required.

## Working norms

- Branches: `feat/<scope>`, `fix/<scope>`. Commits: `type(scope): subject` (match rctrl's history style).
  Lead-dev merges after green `bun run check` + a recorded self-audit pass (re-read the diff as a hostile
  reviewer; the audit note goes in the PR/commit body).
- Work in *this* repo lands on `master` via short-lived branches. Work in **provo (rctrl)** and
  **missoula (tend)** is PRs only, never direct pushes; cite the ledger/letter item each PR answers.
- CI (GitHub Actions): typecheck + lint + unit/integration/loop/e2e on ubuntu (tmux + git installed;
  fake binaries only). Proof runs are manual.
- Docs: decisions → this file or `docs/plan.md` the moment they're made; agent reports → `docs/research/`.
- No `console.log` in committed code. The journal seam is the only runtime narrator; stderr only —
  stdout belongs to the face's structured output.

## Agent protocol (for the lead dev spawning subagents)

- Every implementation prompt includes: this file's path, the exact files to touch, the ledger/test IDs
  in scope, and acceptance criteria (`bun run check` green + which RED tests flip).
- Parallelize only across files/modules that don't import each other; one writer per file per wave.
- Agents report: what changed, what's RED→GREEN, what they did NOT do, any doctrine deviation + reason.
- Review of agent output is the lead's job and happens against the diff, not the report.
