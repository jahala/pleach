# Mining adoption plan — the pleach-shaped versions

**2026-08-18.** Design pass over `docs/research/competitor-mining.md`'s adoption sheet.
Rule of the pass: every item gets its pleach-shaped form — which is usually NOT the
source's form — plus an explicit not-built list. Four items touch the plan schema; they
travel as ONE v1.2 amendment conversation with tend2, not four dribbles. Everything else
is pleach-internal and independent.

Layer discipline throughout: pure decisions in `core/`, I/O in `seams/`, orchestration in
`loop/`, protocol text in prompts owned by `core/` (audit) or the planner (work orders),
CLI surface in `faces/`. No new dependencies. Every item lands RED-first with its ledger
note.

---

## A. Landing verify + bisect (no contract change) — the pre-launch item

**pleach shape.** `landPlan` already builds the sink stack in a throwaway worktree and
publishes only by fast-forward. Insert a land gate between build and publish:

1. **Gate = the union of the sinks' own smoke commands** run on the stack tip. No new
   schema field: the combination must satisfy each constituent's declared acceptance.
   Nodes without smoke contribute nothing (and the receipt work in G makes that absence
   visible). Execution order: topo order; first red stops the pass.
2. **One flaky retry** of the failing command only (gastown's lesson: don't blame an
   innocent sink for a flaky suite).
3. **Bisect with cumulative context** over the sink list: retest subsets merged on top of
   the known-good prefix (the `bisectRight` property — order-dependent interactions are
   caught; a left-half culprit does not exonerate the right half). All merging happens in
   the throwaway worktree; the real branch is never touched.
4. **Terminal check**: re-merge and re-gate the good subset. If THAT fails — merge
   nothing, journal `land-integrity-failed`.
5. **Policy: refuse-all stays the only outcome on red.** gastown lands the good subset
   because it runs a continuous queue; pleach lands a finished plan once, and partial
   landing would silently change what "landed" means. The bisect's value here is the
   DIAGNOSTIC: `LandResult` and the journal name the culprit sink(s) and the evidence.
   Partial landing is a future policy flag if real usage demands it — not now.

Journal events: `land-gate`, `land-gate-retry`, `land-bisect`, `land-culprit`,
`land-integrity-failed`. Narration lines for each.

**Not built:** MR scoring (the DAG orders), merge slots (the conductor lock exists),
building on the real branch, partial landing, any LLM flaky-classification — bisect IS
the deterministic replacement.

**Tests.** Loop (harness): green stack lands; sink red on tip but green alone → bisect
names the interaction culprit, nothing lands; flaky (red once, green on retry) → lands
with journal note; good-subset recheck red → nothing lands. e2e: extend the command-dag
example with two sinks whose combination breaks a smoke.

---

## B. The v1.2 contract batch (schema; tend2 ratification; one conversation)

Four amendments drafted together, each backward-compatible (all optional fields):

1. **`policy.escalation?: string[]`** — model names; attempt N (N≥2) runs with
   `escalation[N-2]`, provider UNCHANGED (the diversity preflight stays sound; a provider
   ladder would silently break audit diversity — deliberately excluded).
2. **`Verdict.status += 'refused'` + `evidence.refusal?: {kind, detail}`** — kinds closed:
   `scope_exceeded` (detail = proposed split, string[]), `underspecified` (detail =
   question), `blocked_on_dependency` (detail = dep name). Worker signals via a
   ```pleach-refusal``` fenced JSON block in its final message (same egress discipline as
   the audit fence: last block wins, parsed not interpreted, unknown kind = contract
   violation = ordinary failure). pleach routes: terminal, no retry burn, no branch,
   summary bucket `refused[]`, narration shout (needs-a-human class). pleach never acts
   on a proposed split — that is the planner's jurisdiction (thin waist).
3. **`Plan.budget?: {maxTokens}`** — run-level breaker. Spend = sum of verdict telemetry
   for this plan.source across the JOURNAL (cumulative across resumes for free — the
   journal already spans runs). Warn (journal + narration) at 80%; at cap: stop
   scheduling, let in-flight nodes reach verdicts (never orphan a worktree mid-gate),
   remaining nodes → `skipped` with reason, journal `budget-exceeded`, summary says so.
   Honesty rule: nodes whose runner reports no tokens (direct-cli) are counted at 0 and
   the run WARNS "budget unenforceable for N node(s)" — never silently pretend
   enforcement. No USD, no pricing tables — tokens are measured and provider-neutral.
4. **`node.context?: [{file, reason}]` + `work.promptPath?`** — context files resolved
   IN THE NODE'S WORKTREE (post-merge — so a dependency's conventions doc written by a
   verified parent is readable), injected deterministically at the TOP of the work order
   (stable prefix before variable evidence — KV-cache locality is free). Missing context
   file = gate failure, fail closed. `promptPath` (mutually exclusive with `prompt`) lets
   plans reference a work order by repo path — reviewable plans, meaningful diffs.

Process: one proposal doc → walkie → tend2 ratifies → schema block + doc + drift test +
CHANGES in one commit, as always. tend2's emitter gains matching emission options at
their pace (their #26 casting policy feeds escalation; their work-order files feed
promptPath naturally).

---

## C. Retry escalation (loop; after B)

Pure function in `core/escalate.ts`: `(node, attempt, failureClass) → {model?}`.
Deliberately narrow rules, documented in the function:
- Only GATE failures climb (`escalation[attempt-2]`, saturating at the last entry).
- `timeout` retries keep the model — a wall clock is not a capability signal.
- `dead` + resume keeps the model — process death is an environment signal.
run-node threads the result into `spawnWorker`. The diversity preflight re-checks against
the RESOLVED audit provider on every attempt (escalation can never converge builder and
auditor providers because escalation is model-only — assert it anyway).

**Corrective retry templates** (no schema): tighten `gateEvidence`/audit evidence into a
closed template set in `core/` — gate name + verbatim output tail + "Fix that specific
failure, re-run the gate, and finish. Do not redo work that already passed." — with a
unit test pinning the template so retry prompts are auditable artifacts.

**Not built:** effort knobs (no such runner surface), text-sniffing retry budgets (typed
reasons only), warm session resume (replayable isolation wins).

**Tests.** Unit: ladder walk per failure class, saturation, timeout/dead hold. Loop:
attempt 2 spawns with escalated model; provider unchanged; audit diversity asserted;
templates pinned.

---

## D. Close receipts + honesty ledger + `pleach receipt` (no contract change)

**pleach shape.** At settle time (close AND quarantine), mint a receipt in `core/receipt.ts`
— pure function over data run-plan already holds:

- `facts`: node id, plan source, attempts, per-gate records `{gate, ran, exitCode,
  outputTailSha}` in ladder order, audit verdicts verbatim (with the tri-state below),
  diffRef / quarantine SHA, stagedFiles count, telemetry, durationMs.
- `degraded[]`: every check the PLAN never configured — `smoke:unconfigured`,
  `audit:unconfigured` — plus anything consulted-but-not-adjudicated. "No coverage is not
  coverage" becomes a recorded fact. (This is plan introspection; near-zero cost.)
- `derived`: the status — recomputable by a pure `deriveStatus(facts)` that the verify
  path shares with the mint path. **Fact set frozen at classify time** (the loki lesson:
  their verifier accused honest receipts of forgery over post-derivation appends).
- Integrity: sha256 over canonical JSON (sorted keys, stable separators). The node
  commit's message gains one trailer line `receipt-sha256: <hash>` — the hash is thereby
  pinned in pushed, immutable git history. Full receipt: journal event + file under
  `<git-dir>/pleach/receipts/<node>.json`.

**Tri-state audit records** (journal + receipt): `pass` / `fail` / `skip` — an auditor
outage or reaudit exhaustion records `skip(reason)`, and skip blocks close exactly as
fail does (behavior unchanged — the RECORD now distinguishes "checked and failed" from
"never adjudicated").

**CLI**: `pleach receipt <node> --repo-root .` → loads receipt, re-hashes, compares to the
commit trailer, re-derives status from facts, resolves diffRef, prints PASS/TAMPERED/
UNDERIVABLE with the degraded ledger. Exit codes 0/1/2.

**Not built:** GPG/JWKS/attestation (git commit signing over pinned hashes covers
provenance), receipt chaining (the branch DAG is the chain), remote receipt distribution
(the hash travels with git; the file is local until a real need appears).

**Tests.** Unit: mint/canonicalize/rehash; tamper flips PASS→TAMPERED; deriveStatus
round-trips every verdict class; degraded computed correctly for gate-less plans. Loop:
receipt events on close and quarantine; trailer present in commit message. e2e: CLI verb
on a real close + a hand-tampered receipt.

---

## E. Diff-hygiene gate (no contract change)

One new ladder step after scoped staging, before smoke — `core/hygiene.ts` pure scan over
the staged diff (new seam read: `isolate.stagedDiff(cwd)` + `stagedNumstat(cwd)`):

1. **Empty-diff attribution**: a `{prompt}`/`{phases}` node with an empty staged set →
   retryable failure with evidence "your attempt produced no changes" (a command node may
   legitimately be effect-free; agent nodes may not claim done on nothing). Bernstein has
   the incident archive proving this hole is real.
2. **Secrets battery**: ~12 high-signal regexes (AWS keys, GitHub tokens, private key
   blocks, generic `api_key=` long literals…). High precision over recall — a noisy gate
   gets disabled by users, which is worse than a narrow one. Hit → retryable ("remove the
   credential; use an env var"), terminal → quarantine (documented: the quarantine branch
   contains the hit — local evidence, never a published node/ branch).
3. **Deletion tripwire**: any single file with >50% of its lines deleted AND >100 lines
   deleted → retryable with the filename ("if intentional, re-state it in your final
   message" — retry with the same diff and an explicit confirmation in the manifest
   passes; the gate is a tripwire, not a wall).
4. Protected paths: NOT a new list — SEC4's audit-command protection already covers the
   gate files; `.git` is unreachable by construction. A plan-declared protect list is
   schema surface we don't need yet.

Default ON, no flag. If real usage shows false-positive pain, the escape hatch discussion
happens then, with data.

**Tests.** Unit per detector (incl. the confirmation pass for deletions). Loop: each
failure path retries with the right evidence and quarantines at exhaustion; command nodes
exempt from empty-diff. e2e: one secrets case through the CLI.

---

## F. Falsification guidance + prompt hygiene (skill + docs only)

The adversary-prompt idea does NOT belong in `buildAuditPrompt` — pleach's auditor runs a
command and relays; it holds no judgment latitude, and giving it findings-authoring
instructions would be slop. The pleach-shaped home is check AUTHORING:

- `pleach-plan` skill: checks/smoke guidance gains the falsification rule — every check
  states what failing looks like; "if you cannot construct the failing case, the check is
  too vague — drop it or split it." Plus the two escape hatches as plan-shape advice
  (oversized nodes → split; unverifiable claims → human check, not a fake command).
- `docs/adapters.md` audit section: one paragraph for third-party audit-command authors
  (verdicts carry reasons; reasons should name the falsifying evidence).

---

## G. Sweep-ups (independent, small)

1. **Worker session id in the journal**: `Worker` gains optional `id` (informative seam
   field, deps.ts — not the plan contract); umbel reports its session/pane, direct-cli its
   pid. `node-start`/`verdict` events carry it. A dead worker becomes post-mortemable.
2. **`reasonCode` vocabulary**: closed, versioned enum in core (`gate-red`, `gate-tampered`,
   `egress-unparseable`, `worker-dead`, `timeout`, `budget`, `refused`, …) attached to
   failure-class journal events. Consumers must treat unknown codes as `unknown`.
3. **`git merge-tree` pre-probe in land**: before building the stack, probe sink pairs and
   journal expected conflicts (informational only — the real merge still decides).
4. **Doctrine tests**: (a) a gate-less node's close carries `degraded[]` entries (lands
   with D); (b) grep-level ledger test: no `branch -D`/`update-ref -d`/`worktree remove`
   call site without a reachability-proof comment — the gastown rule as a cheap tripwire.

---

## Sequencing

```
A (landing verify+bisect)     ── independent, FIRST (pre-launch trust point)
E (hygiene gate)              ── independent, cheap, second
D (receipts + honesty)        ── independent, third (the pitch artifact)
B (v1.2 batch w/ tend2)       ── the contract conversation, in parallel with D/E
C (escalation)  ┐
refusal, budget,│             ── after B ratifies, in ladder order C → refusal → budget → context
context (from B)┘
F, G                          ── woven in wherever a batch has room
```

Nothing above outranks the launch itself except A. Every item: RED first, ledger entry,
`bun run check` green, CI-watched merge — the usual rhythm.

---

## Review outcome (tend2, 2026-08-18 — outsider review, ground-truth-checked)

All sections AGREED; amendments folded below. One real finding earned the review its
keep before a line was written: **§A would have been vacuous for tend2-emitted plans** —
their smokes shipped without `--force`, and verify's staleness keys to claim/evidence
content, so at the land tip a just-stamped check skip-freshes even when a sibling sink
changed the source under test. Fix is theirs (emit `--force`; lanes become consistent);
the canary fixture re-pins when their PR lands.

**§A amendments:** dedupe identical smoke command strings before running the union
(exact-string only); DOCUMENT that gate commands may write to the throwaway worktree
(tend2's verifier stamps on re-run) — never add a clean-tree-after-gate assertion.
**§D amendments:** journal keeps VERBATIM output tails (receipts hold `outputTailSha`
referencing them — their failure briefing reads the journal for text; confirmed);
receipt facts gain `contractVersion` + `pleachVersion` (a version fence so old receipts
fail derivation honestly, not mysteriously); `land-culprit` carries the failing smoke's
output tail; **degraded[] surfaces in the close-time narration/summary line** (trust
decisions happen at close, not at receipt-inspection); G4a folds into D.
**§E amendments:** empty-diff retry evidence appends "if no change is needed, run the
gate so the stamp lands in your diff" (the tend2-lane already-green case self-heals in
one retry); known trap recorded — hygiene's own test fixtures contain lookalike secrets,
so the first node editing them trips the battery on itself (fixture naming/allowlist at
build time).
**Cut:** G3 (merge-tree pre-probe) — informational noise; bisect names culprits with
evidence. Revive only on a real conflict postmortem.

**v1.2: all four amendments RATIFY-READY** with prose requirements accepted: escalation
semantics live in contract prose (attempt N runs `escalation[N-2]`, saturating;
provider-unchanged is contract LAW; which classes climb is runner policy); the budget
unenforceable-warning is NORMATIVE ("a runner that cannot count tokens MUST warn, never
silently pretend enforcement"); promptPath resolves in the node's worktree post-merge,
missing = gate failure (same rule as context files); when both present, context block
prefixes promptPath content. tend2 ships emission support post-ratification; canary
re-pins with (4). Draft-on-convergence is armed — drafting awaits the owner's build go.
