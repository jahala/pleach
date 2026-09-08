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

## Track work in tend2 (this repo dogfoods itself)

The garden is `docs/tend2/` (hub: `garden.tend2.html`; one `<id>.tend2.html` per loop). A page is markdown
inside `<script type="text/markdown" id="loop">` — edit it by hand; it is NOT a bash polyglot. Checks are
`- [ ] (code) claim · evidence-path`; **only `tend2 verify` writes a pass** (`[x] … @sha`). If the map isn't
updated, the next session starts blind.

- **See where things stand:** `tend2 next docs/tend2` (stale stamps, what needs you) · `tend2 lint <page> --strict`.
- **Before multi-file work,** find the loop that owns it (`ls docs/tend2/`). None → shape one: page first
  (Goal, How, Impact, `## Tests` with an evidence path per check, `## Needs`, `## For`, dated `## Tried`),
  register it in the hub's `## Children`, and a `docs/ledger.md` item — then code.
- **Earn a pass:** `tend2 verify docs/tend2/<id>.tend2.html --repo-root . --runner "bun test {evidence}"`
  (`--check N` for one check; `--force` re-runs a fresh stamp). A hand-flipped `[x]` renders as a claim.
- **Every handback ends with a dated `## Tried` line** — what was done, what was rejected and why.
- **Conducted builds:** `tend2 emit-plan docs/tend2 --repo-root . --verify-bin /opt/homebrew/bin/tend2
  --runner "bun test {evidence}"` emits the pleach plan (known gaps: one node per loop, no phased nodes —
  see `docs/dogfood/make-plan.ts` for the hand-split shape used here).

## Gotchas

- **The garden lives at `docs/tend2/`** (`tend2` is on PATH — `/opt/homebrew/bin/tend2`); the pages are
  self-contained (loop.css/loop.js live inside `docs/tend2/`). Stamps live in the page and are
  content-keyed — editing evidence re-opens its check; re-migration resets un-earned state. The v1 garden
  is FROZEN history at `docs/tend/` — never run a formatter over either garden (`biome.json` includes
  `**`; a bare `biome check --write .` rewrites the polyglots and tend2's renderer; the `lint` script is
  scoped to `src test` for that reason).
- **`docs/research/` is local-only** (gitignored, untracked): candid competitor analysis and internal
  records. Never re-track it; new research goes there and stays private. Cross-references to it from
  tracked docs are provenance labels for maintainers, not public links.
- **`.brand/` is a pulled cache** (gitignored, untracked — see `.petalsrc`); the landing page renders
  without it. `.mcp.json` is gitignored + machine-specific; its `tend` entry must be `tend2 mcp`
  (the v1 `dist/bin/tend.js serve` path is gone — a stale entry fails as CONNECTION_CLOSED at session
  start), and its pollen entry carries `POLLEN_ID=pleach` + `POLLEN_ALLOW`.
- **Dogfood record:** every conducted loop keeps `docs/dogfood/<loop>.md` (faults, misunderstandings,
  missing features in tend2/pleach/umbel/weeder hit while building it) beside `docs/dogfood/<loop>/`
  (its spec + plan). Real defects become issues on the tool's repository.
