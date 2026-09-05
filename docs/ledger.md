# tend ⇄ conductor ⇄ umbel — verification report & build plan

**Status: verification round, post-ratification.** The build-spec v0.3 (`missoula/docs/bridge/tend-umbel-build-spec.md`)
was ratified "build-ready" after five rounds. This document is the result of a three-way verification —
spec ⟷ tend's actually-built bridge code ⟷ umbel's actually-shipped surface — plus an adversarial attack
on the conductor loop. **Verdict: the spec's git/concurrency core is sound (several attacks refuted), but
the system as specced+built cannot complete a multi-step feature, cannot resume across runs, and can
commit unresolved conflict markers into verified branches.** The defects below must be ratified through
the bridge channel (a v0.4 / conductor-spec v1.0) before the first conductor commit. Every defect becomes
a failing test first.

Naming (proposed at time of writing, npm-checked — see §6): conductor → **pleach**, umbel → **rootstock**
(rootstock was the leading candidate; **umbel was ultimately kept** — it is the current name). The working
names pleach/tend/umbel are used throughout this repo.

---

## 1. Defect ledger

Severity: ⛔ blocker · ⚠ serious · ◦ minor. Source: [adv] adversarial review, [code] verified against tend's
built bridge, [umbel] verified against umbel source, [me] prior whole-system analysis.

### Class A — semantic deadlocks (the loop cannot complete honest work)

- **A1 ⛔ [code] Non-audit nodes can never close.** `ingester.ts:113-115`: `emitVerdict` returns
  `{closed:false}` for any verdict whose output isn't an `AuditResult` — including a `{command}` or
  `{prompt}` node that *succeeded* (`status:'done'`, `output:undefined`). The conductor loop treats
  `closed:false` as failure → branch never publishes → all dependents blocked. The generator does NOT
  guarantee audits everywhere: `accept.audit` is attached only when `feature.checks.length > 0`
  (`generator.ts:143-146`). **Fix:** the conductor closes non-audit nodes itself on done + smoke-pass;
  tend's gate is consulted only where there is something for tend to decide.

- **A2 ⛔ [code, high-confidence — needs one characterizing test] Step-nodes × feature-audit mismatch.**
  The generator emits **one node per STEP** (`node.id = step.id`, `generator.ts:194-212`), but (a) every
  node of a feature carries the *full-feature* audit `tend audit <feature>` (`generator.ts:143-146`) — so
  step 1 of 5 is audited against checks that can only pass when all 5 steps are done → step 1 "fails" →
  feature deadlocks; and (b) the ingester keys `featureId = v.node` (spec §4 — "v1: node.id IS the feature
  id"), which is now a *step* id → the write targets a nonexistent feature. Also `readClosed` returns
  **feature** ids, so step-level `needs` are never satisfied from the resume checkpoint. Three independent
  id-space mismatches between tend's own generator and ingester. **Fix (recommended):** generator emits
  step nodes *without* audit (they close via A1's non-audit path) **plus one terminal per-feature
  integration node** carrying `accept.audit` and `needs: [all step ids]`. This also gives every feature a
  natural landing/integration point (see B3).

- **A3 ⚠ [me, absence confirmed in code] The nudge loop is missing.** Audit-fail is terminal — `reasons[]`
  are recorded and never shown to any worker; retryable retries blindly re-send the identical prompt to a
  *fresh* worker (workers are killed inside `runWork`). The orchestration doc's core effect ("auditor's
  reasons fed back, fixed in-context") doesn't exist in the spec or code. **Fix:** on retry, append failure
  evidence (smoke exit + output tail, audit `reasons[]`, conflict-file list) to the re-prompt; classify
  audit-fail as `retryable` (reuse tree — build exists, is just wrong), bounded by `maxAttempts`.

### Class B — state-lifetime split (tend status vs git branches)

The single deepest theme [adv]: **`node/<id>` branches and tend's `verified` status are treated as one
checkpoint but have different lifetimes and trust domains.**

- **B1 ⛔ [adv, unguarded per code] Resume isolates off missing refs.** `readClosed` returns every feature
  tend has *ever* verified (incl. manually / previous runs / other clones); dependents' `baseRefs` are
  `node/<id>` — local refs that don't exist for out-of-band-verified deps → catastrophic isolate failure →
  the whole subtree permanently unbuildable. Nothing in tend's code guards this. **Fix:** persist the
  verified commit SHA into tend via `Verdict.evidence.diffRef`; `readClosed` returns `Map<id, sha|null>`;
  baseRef resolution: `node/<id>` if present, else the recorded SHA, else HEAD-if-landed, else "rebuild
  required" error.

- **B2 ⛔ [adv] Verified-without-branch is permanent.** `emitVerdict` (durable) runs *before*
  `commitBranch` (local); a crash between them leaves tend saying verified with no artifact — and no
  reconciliation pass ever repairs it because `ready()` skips closed nodes. **Fix:** commit **before**
  emit; startup reconciliation: `∀ id ∈ closed: ref-or-SHA must resolve`, else treat as needs-rebuild.

- **B3 ⚠ [me] The last mile is unspecified.** Verified work sits on `node/<id>` branches; nothing lands it
  on the user's branch — tend says verified while the working branch lacks the code. **Fix:** convention:
  every feature's terminal integration node (from A2's fix) is the landing unit; landing policy (auto-merge
  vs human merge) is an explicit conductor flag, not an omission.
  - **Implemented (2026-08-16):** `pleach land <plan>` + `pleach run --land` (`src/loop/land.ts`,
    `IsolateSeam.land`). All-or-nothing: refuses unless every plan node is verified-closed; sinks resolve
    through the B1/C5 baseRef chain; merges build in a throwaway worktree and the checkout is touched only
    by a final `--ff-only` (conflict → `LandConflictError`, repo untouched). Tests: `test/unit/land.test.ts`,
    `test/integration/land.test.ts`, `test/loop/land.test.ts`, `test/e2e/land.test.ts`.

- **B4 ⚠ [adv] No single-conductor lock.** Two conductors on one repo race `branch -f`, the worktree pool,
  and the ingester. **Fix:** `O_EXCL` lockfile per (repo, source); refuse to start if held.

### Class C — gate integrity (what "verified" actually proves)

- **C1 ⛔ [adv] Conflict markers get committed into verified branches.** Conflicts are deliberately kept
  for the agent — but nothing ever verifies resolution. `git add -A` stages literal `<<<<<<<` text; once
  committed, dependents merge it *cleanly* (it's ordinary content now) and the poison spreads silently
  through the subtree. **Fix:** mandatory `git diff --check` (or marker grep over staged files) before
  audit and before commit; on hit → retryable with the file list fed back (A3).

- **C2 ⚠ [adv] `git add -A` sweeps junk into verified commits** — node_modules from test installs,
  audit-worker droppings (the auditor shares the cwd and writes evidence/scratch *before* the commit-time
  `add -A`), coverage dirs. **Fix:** scope staging to `WorkerResult.filesTouched` (already captured, then
  thrown away) or a conductor-injected excludes file.

- **C3 ⚠ [adv] Phases RED-gate false-positives on fresh worktrees.** A fresh isolate has no installed
  deps; `npm test` exits non-zero because the *runner can't load* — RED "passes" on an environment error,
  silently defeating the TDD guarantee; dead-retry re-isolates re-pay the full install. **Fix:**
  `Node.setup?: string` (schema addition) run once post-isolate; RED must distinguish "test collected and
  failed" from "harness errored" (baseline dry-run).

- **C4 ⚠ [adv + umbel] Audit-parse failure burns a good node.** `AuditResultSchema.parse` throws inside
  `runNode`'s catch; `classify()` has no row for it — a mis-formatted audit message fails a build that
  passed its gates. Truncation makes it worse — but **umbel already ships the fix surface**:
  `umbel_read full=true` (`mcp.ts:114`, marker at `truncate.ts:84`); the CLI `read` never truncates.
  **Fix:** seam reads finalMessage untruncated (mandatory); distinct `AuditParseError` taxonomy row that
  re-runs *only the audit worker*, bounded separately.

- **C5 ⚠ [adv] Worker can attack the substrate.** From inside the worktree a worker reaches the shared
  object store/refs (`git branch -f node/<dep>`) and the worktree's copy of the tend polyglots. The
  cross-provider audit defends the *report* path, not the substrate. **Fix:** conductor reads tend state
  only from outside worker-writable paths (main checkout / MCP); record the SHA of each `node/<id>` it
  creates and verify before use.
  - **(A) verify-before-use: implemented** (`src/loop/run-plan.ts`). `settle` pins each closed node's
    baseRef to its committed SHA (not the movable `node/<id>` branch). `resolveBaseRef` compares the
    recorded SHA against the current branch tip at startup; a mismatch throws `RebuildRequiredError`
    before any node runs. Tests: `runPlan — C5 SHA pinning` (WITHIN-RUN + STARTUP), `test/loop/run-plan.test.ts`.
  - **(B) read-from-outside-worktrees: verified-sound** — `readClosed` / `emitVerdict` go through the
    `LedgerSeam` (tend MCP / gitLedger), which resolves over the main checkout, not any worker worktree.
    The worker has no write path into that seam.

- **SEC4 ⚠ [2026-08-16, source: Anthropic Frontier Red Team multiagent report — see
  `docs/research/multiagent-lessons.md`] Gate tampering / audit collusion via the shared worktree.**
  The auditor works in the tree the builder wrote: (a) a repo-local audit command (`bash git-audit.sh`)
  is builder-writable — rewrite it to print a passing fence and every gate goes green; (b) repository
  content can prompt-inject the auditor into skipping the command. No malicious model needed — a
  reward-hacky builder under retry pressure suffices. C5 hardened refs, not gate content.
  - **Implemented (same day):** (a) `auditGateTampering` (`core/audit-egress.ts`) — audit-command
    tokens matched against the attempt's staged set; a hit is a retryable gate failure with revert
    evidence, terminal at `maxAttempts` (quarantined), and the auditor is never spawned. A reverted
    file is clean vs HEAD, so an honest touch recovers on retry. (b) `buildAuditPrompt` inoculation:
    repository content is untrusted data; run only the given command. Tests:
    `test/unit/gate-integrity.test.ts`, `test/loop/gate-integrity.test.ts`. Rule of thumb: audit
    commands should live outside worker-writable paths (`tend audit` does); the integrity check
    covers the repo-local case.

### Class D — robustness, config, hygiene

- **D1 ⚠ [adv] No timeouts anywhere.** `Node` has no timeout field; no `exec()` call passes `timeoutMs`;
  `Worker.wait()` takes none. A hung worker or hung smoke command deadlocks the run (consumes a slot
  forever). umbel's default wait is 30 min (`operations/wait.ts:86`). **Fix:** `policy.timeoutMs`
  (schema addition), threaded through wait and every exec.
- **D2 ⚠ [me + umbel] Needs-input has no policy.** umbel `wait` can settle `'input'`/`'idle'`
  (`operations/wait.ts:35`) but the seam's reason enum omits both. Compounding: `allowedTools` is a
  **silent no-op on codex/gemini/opencode** — and the audit provider is hardcoded `'codex'`
  (`generator.ts:56`). **Fix:** seam maps `input|idle`; v1 policy = kill + distinct `'blocked'` status
  (human attaches); umbel makes `allowedTools` work-or-error per provider (see §3).
- **D3 ◦ [adv] No plan validation** — cycles/unknown `needs`/duplicate ids silently skip or corrupt;
  `Node.id` is an unvalidated string interpolated into shell (`node/<id>`). **Fix:** `validatePlan`
  (toposort, uniqueness, id regex `^[A-Za-z0-9_.:-]+$`) before the loop; exec via arg-arrays
  (`execFile`-style); declare plans trusted-input-only in the spec.
- **D4 ◦ [code] Generator omissions vs spec:** multi-`needs` "resolve any merge conflicts" prose not
  implemented (`stepToNeeds`, `generator.ts:127-133`); spec §2 `LedgerSeam.emitVerdict` signature diverges
  from code (`(v, source)`, `ingester.ts:109-112`) — reconcile spec to code.
- **D5 ◦ [me] Evidence = extractor quality.** `filesTouched` comes from umbel's ActionManifest
  (`filesRead/filesEdited/filesWritten`, `providers/types.ts:33-62`); codex/gemini/opencode extraction is
  explicitly unverified. Codex (the auditor) first.
- **D6 ◦ [adv] Dead config fields** — `policy.budget` unenforced, `reauditWhen` dormant (telemetry empty
  v1), `closes` unread by the loop. Mark `[ROADMAP]`-inert at the schema site or warn on use.
- **D7 ◦ [adv] `closed` Set mutated in place** — defensive-copy what `readClosed` returns.
- **D8 ✅ [me] `pleach --help` exited 2 with "unknown flag".** The HELP text advertises `--help`, but
  `parseFlags` (which rejects unknown flags) ran BEFORE `runCli`'s help check, so the one flag every
  user tries first was refused. Found 2026-08-20 verifying the receipt verb on the global bin.
  **Fix:** the help check rides ahead of flag parsing (`runCli`); a bare invocation still prints usage
  and exits 2 (not a request for help). Tests: `test/e2e/help.test.ts` (real process, all three shapes).
- **D9 ✅ [field] Land gate red on a green composition — the stack had no environment.** Work worktrees
  get `node.setup` post-isolate; the land gate's throwaway stack got NOTHING, so dep-needing smokes
  (`npx vitest` with no node_modules) read red and the bisect named innocent sinks. Found on §A's first
  field use (decker wave 1, 2026-08-20: 6/6 closed, 83/83 green with deps, land refused). Companion
  trap, documented in the skill: encoding the install into `accept.smoke` changes acceptance identity
  and re-dispatches every verified node via the acceptance-evolution cascade — provisioning belongs in
  gate ENVIRONMENT, never in acceptance text. **Fix:** the gate runs the sinks' own deduped setup union
  in the stack (and in every bisect probe + the coherence recheck); a red setup refuses as
  `land-setup-failed` (environment) and never enters the bisect. Tests: `test/loop/land-gate.test.ts`
  ("provisions its stack" describe — dedupe+ordering, environment refusal, provisioned probes).

- **D10 ✅ [field] Node-gate red with no taxonomy and no evidence.** decker wave 2: convert-engine
  quarantined on a gate red while the work was green (104/104 in its worktree; landed from quarantine,
  verifier stamped 4/4) — and the failed verdict carried an EMPTY output tail. Two holes: a transient
  gate red became worker evidence / quarantine with nothing distinguishing environment from work, and an
  empty tail left the operator debugging blind. **Fix:** (1) exec gates (setup, smoke) get ONE gate-only
  retry in the same provisioned worktree before a red becomes evidence — the land gate's flaky-retry
  doctrine at node level (`gate-retry`/`gate-flaky` journal events); a worker re-prompted for a failure
  that wasn't its fault "fixes" what isn't broken. (2) A red with no output records an explicit
  no-output marker — the absence of evidence is itself diagnostic. Deliberately NOT built: the fresh-
  worktree environment reclassification (commit staged work + re-isolate + replay) — adopt only if
  field data shows corrupted-tree cases the same-tree retry misses. Tests:
  `test/loop/gate-retry.test.ts` (flaky-pass, persistent-red evidence, no-output marker, setup parity).

- **D11 ✅ [field] Terminal verdicts could leave zero evidence.** bandung's dogfood (2026-09-05,
  P1+P2): a worker dead in 8s with a clean tree left NO receipt, NO quarantine, and a bare
  `status:'dead'` line (the receipt write hid behind the quarantine commit; the dead verdict was
  built without even a gate record) — diagnosis took a manual spawn. And a blocked node's tree was
  DISPOSED on the theory that an unfinished turn holds nothing — workers edit files mid-turn; 9m40s
  of work was discarded and rebuilt from zero. **Fix — no terminal verdict without an artifact:**
  the receipt always writes at terminal settle (refs attach only when a quarantine commit landed);
  blocked hands its tree back and quarantines exactly like failed (unfinished is not wrong); dead
  verdicts carry `gate.ran: 'wait:dead'` plus optional runner detail (`paneTail`/`processExit` on
  `WorkerResult`, journaled when the runner supplies them — the pleach half of umbel's
  pane-capture-at-death, never fabricated). Tests: `test/loop/terminal-evidence.test.ts`.

### Verified-sound (attacks refuted — do not relitigate)

`--detach` fan-out (two detached worktrees at one commit are legal); the closed-add-then-dispose-inside-
the-inflight-promise ordering (single-process); `Promise.race` never sees a rejection; the semaphore;
the cross-provider audit blocking worker-forged audit reports; **zero schema drift** (the drift-guard test
mechanically pins `plan.ts` to spec §1 byte-for-byte, `.prefault({})` included). Also ahead of schedule:
**`tend audit` is fully built** (`src/cli/audit.ts` in missoula/tend — not a pleach path; pleach's
audit-egress equivalent is `src/core/audit-egress.ts`; compute/apply split enforced by static import-guard
tests; delimited ` ```tend-audit-result ` block + `extractJson` recovery) — the §7 roadmap item is done.

---

## 2. Conductor — spec deltas for v1.0 (supersedes spec §2/§3 reference impl)

The conductor becomes its own package (the third leg; hosts the schema; both seams injected). Design
changes, mapping to the ledger:

1. **Close semantics (A1/A2):** audit nodes → tend decides; non-audit nodes → conductor closes on
   done + smoke-pass + marker-check-pass. Node granularity per A2's fix (step nodes + terminal
   per-feature integration/audit node).
2. **Branch/status atomicity (B1/B2):** commitBranch before emitVerdict; SHA persisted via
   `evidence.diffRef`; `readClosed → Map<id, sha|null>`; baseRef fallback chain; startup reconciliation.
3. **Gate hardening (C1–C5):** marker check before audit + commit; scoped staging from `filesTouched`;
   `Node.setup` install hook; untruncated audit egress + `AuditParseError` row (re-audit only); tend reads
   from outside worker-writable paths; verify created-ref SHAs.
4. **Feedback loop (A3):** retry-with-evidence re-prompts; audit-fail retryable with reasons.
5. **Robustness (B4, D1–D3, D7):** lockfile; `policy.timeoutMs` threaded everywhere; `validatePlan`;
   arg-array exec; defensive copies; run journal (JSONL) from day one.
6. **Schema changes** (frozen schema — bump via the spec doc, both vendored copies + drift tests move
   together): `Node.setup?: string`; `policy.timeoutMs?: number`; `Verdict.status += 'blocked'`;
   document `budget/reauditWhen/closes` as v1-inert.

Build order inside the conductor repo (test-first, per §6 of the old spec + new cases):
schema vendoring + drift test → `validatePlan` → isolate (detach/merge/markers/setup/dispose; fan-out +
concurrency-invariant + junk-staging + marker tests) → seam stubs → `runPlan` loop (close paths, retry
ladder, timeouts, lockfile, reconciliation) → live seams → **the proof run** (one honest-partial,
multi-step feature — chosen precisely because it trips A1+A2 if they're mis-fixed).

## 3. umbel change plan

Phase R1 — seam blockers (before the conductor's live-seam step):
1. **`wait --json`**: structured `{reason, message, paneSnapshot?}` on stdout (CLI is the seam's
   transport; exit codes alone conflate input/idle — both 126 today).
2. **MCP `sinceMtime` hole**: add to `VerbSchemas.wait`, thread through `umbel_wait` (keystone-correctness
   fix regardless of the bridge).
3. **`allowedTools` honest-or-error**: hard error on providers where it's unimplemented (codex/gemini/
   opencode) instead of silent no-op; investigate codex's native sandbox/approval flags as the real
   implementation (the auditor is codex).
4. **Verify the codex extractor** against real transcripts (smoke-gated); claude is already
   high-confidence. Evidence quality is gate quality.
5. Exit-code split for input vs idle; document the exit-code table in `--help`.

Phase R2 — hygiene (from the standalone audit; do alongside): fs-state tmp-file `randomBytes`;
malformed-JSONL handling aligned between `jsonl.ts` and providers; `WorkflowCycleError → exit 2`;
inline MCP schemas (`actions`/`diff`/`logs`) moved into `VerbSchemas`; stale `claude.ts` re-export and
`types.ts` "structural placeholders" comment removed; the three vacuous tests + permissive wait
assertions fixed.

Phase R3 — trust layer (the conductor is the customer, in its order): telemetry (`compacted` first →
lights up tend's dormant `reauditWhen`) → `invoke --accept --schema` (absorbs the conductor's per-node
gate/retry loop; conductor slims to scheduling + git + ingestion) → `keys`/interrupt → self-healing
resume.

## 4. tend change plan

Phase T1 — bridge correctness:
1. **Node granularity fix (A2)**: generator emits step nodes audit-free + terminal per-feature
   integration node carrying `accept.audit` + `needs:[steps]`. Decide and ratify via the bridge channel
   first (it changes what the ingester receives).
2. **SHA persistence (B1)**: `emitVerdict` stores `evidence.diffRef` (commit SHA) on the feature's audit
   record; `readClosed` returns `Map<id, sha|null>`.
3. Multi-`needs` conflict prose in the generator (already a named §8 build note).
4. Spec-to-code reconciliation: `emitVerdict(v, source)` signature; `readCatalog` naming; the
   status-omission-on-non-pass behavior (code is more correct than spec — spec moves).

Phase T2 — already-promised roadmap: structured `negctrl` on stored `AuditVerdict` (tightens the gate to
no-pass-without-discrimination in stored form); drift→bets skill (consume `AuditDrift.action`).

## 5. Process

The spec said "no v0.4 — next artifact is code." Verification found blockers, so the honest move is one
more ratification pass — **conductor spec v1.0** (this document's §2 deltas + schema bump), run through
the same bridge-conversation channel so both sides re-converge, then code with every ledger item as a
failing test first. The proof run remains the milestone and the demo.

---

## 6. Naming (garden suite) — checked against npm 2026-06-12

First-choice candidates died on availability: **trellis** is taken AND `trellis-cli` is a same-category
product ("planning and build harness for AI… works with Claude Code, OpenCode, and Codex") — avoid the
word entirely; **arbor** is taken (a build CLI), `arbor-cli` is a version-control CLI, and npm's own
installer library is famously `@npmcli/arborist` — muddy. Also taken: graft, sow, stake, cane, cloche,
twine, tendril, dibber, drill, obelisk, pergola, orchard, coppice, holdfast, scion, espalier (placeholder
squat). **Free on npm:** `pleach`, `rootstock`, `parterre`, `copse`, `almanac`, `withy`, `sward`,
`furrow`, `plotplot` (the suite name itself!), and — notably — `umbel`.

Recommended pairing:

- **conductor → `pleach`** (FREE) — *pleaching* is the craft of training and interweaving living branches
  into a single structure (pleached hedges, interlaced canopies). The conductor's core mechanic *is*
  interweaving branches — git branches of living work — into one verified canopy, with gates as the
  pruning. Short, verby (`pleach run plan.json`), pronounceable ("pleech"), and a more precise metaphor
  than arbor was.
- **umbel → `rootstock`** (FREE) — the hardy, neutral stock any vendor's scion is grafted onto: the stock
  provides the reliability, the scion varieties (providers) churn season to season, and the graft union
  (the adapter) absorbs the difference. This is the positioning thesis ("anchor identity to the contract,
  not the substrate; adapters absorb vendor churn") rendered as horticulture. Caveat to weigh: Rootstock
  (RSK) is a known Bitcoin sidechain brand — different category, but it pollutes search. Fallbacks:
  **`withy`** (the flexible willow tie binding a plant to its stake — obscure but free and short), or
  simply **keep `umbel`** (free on npm) and let the suite story live at the pleach/tend layer.

Suite note: `tend` itself is taken on npm (hence `tend-cli`), so a consistent alternative is claiming the
free **`plotplot`** scope and shipping `@plotplot/pleach`, `@plotplot/rootstock`, `@plotplot/tend` with
short binary names. The contract package, if it wants a garden name: **`furrow`** (free — the row the
sowing must fit). Homebrew/GitHub-org diligence still to do once names are picked.

The layer story: **tend** decides what the garden should bear; **pleach** interweaves the branches into
one verified canopy; **rootstock** holds each graft steady while scion varieties come and go; the agents
are the plants; git + tmux are the soil.
