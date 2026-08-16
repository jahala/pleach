# P6 Proof Run — wordcount

First real execution of the conductor against real agents (claude builders, codex
auditor) + real tend (missoula ingester), on the `examples/proof` wordcount payload.
Per ENGINEERING.md §P6: the run names the next defect; we fix it RED-first.

Setup: `examples/proof/project` copied to a throwaway git repo, `pleach run` with
`--repo-root <copy> --tend-module …/missoula/src/core/bridge/ingester.ts
--max-concurrency 2`, real `umbel` binary on PATH.

## Run 1 — named defect #1: audit egress unparseable

- `wordcount.s1` (countLines) and `wordcount.s2` (countChars): real **claude**
  builders, test-first, smoke-gated (`bun test`), committed to `node/<id>` branches,
  **closed** with SHAs. The full spawn→build→wait→smoke→commit→close loop works.
- `wordcount` (integration + codex audit): **failed** — gate
  `tend audit … (egress unparseable)`, exitCode −1.

It reached `parse-exhausted` (not `worker-fault`), which `runAudit` returns only on a
`stop` reason — so the codex auditor *completed* its turn; it did **not** block on
approval. The failure was purely egress.

**Root cause.** `runAudit` sent the auditor the *bare command*. codex ran it, but the
deterministic ` ```tend-audit-result ` block lived in the tool's stdout while codex's
**agent message** was a prose summary. `extractAuditJson` reads the agent message →
found no block. (Confirmed by elimination: `tend audit` run directly emits a clean
block that `extractAuditJson` parses fine — c1 even passes on a real git repo.)

**Fix (RED-first).** `core/audit-egress.ts` now also exports `buildAuditPrompt(command)`
— it owns both halves of the egress contract: elicit the block, then parse it. The
prompt instructs the auditor to reproduce the fenced block verbatim as the final content
of its reply. `runAudit` sends `buildAuditPrompt(audit.command)`. Unit tests added;
`bun run check` green (177 pass). Validated against **real codex**: with the new prompt
codex pastes the block character-for-character and `extractAuditJson` parses it (c1:
pass). Commit `c18063e` on `fix/audit-egress-relay`.

## Run 2 — fix verified; honest-middle reached (working as designed)

- `wordcount.s1` / `wordcount.s2`: done + closed (real claude).
- `wordcount`: **done** (attempts: 1) — the codex audit ran, codex relayed the fence,
  pleach parsed it, no `fail` verdicts. **Defect #1 resolved end-to-end.**
- Then **not-closed** → run marks `wordcount` failed.

This is **correct behavior, not a defect.** tend's `deriveResult` returns `pass` only
when EVERY verdict is pass *and* discriminated; `verified` is set only on `pass`. The
payload's **c2 has no negctrl by design** (the README: "capped at partial … proves
tend's honest-middle works"), so the feature result is `partial`, tend refuses
`verified`, and `emitVerdict` returns `{closed:false}`. The honest-middle guardrail
correctly prevents a partially-discriminated feature from being marked verified.

## Run 3 — full verified close (all open items resolved)

After the robustness fixes landed (c2 negctrl, conductor `partial` bucket, umbel codex
permission bypass + seam wiring), re-ran on a fresh seed with the reinstalled umbel
binary. **Every node closed:**

```json
{"closed":["wordcount.s1","wordcount.s2","wordcount"],"failed":[],"partial":[],"skipped":[],"blocked":[]}
```

Journal trail (`proof-journal.jsonl`): `run-start → node-start s1/s2 → verdict s2 done →
closed s2 → verdict s1 done → closed s1 → node-start wordcount → verdict wordcount done →
closed wordcount → run-end`. Three `node/<id>` branches published; exit 0.

What changed since Run 2, end to end:

- **c2 negctrl** (`722fc40`): c2 now flips `chars: countChars(text)` → `+ 1` under a test,
  so the audit's negative control discriminates and **both** c1 and c2 are
  pass+discriminated. tend's honest-middle `deriveResult` returns `pass` → `verified` →
  `emitVerdict {closed:true}` → pleach closes `wordcount`.
- **codex audited in a worktree without blocking.** umbel now delivers codex's Stop hook
  via a shared `$CODEX_HOME` (PR #34 — a project `.codex/hooks.json` is silently ignored
  in linked worktrees), and maps `--permission-mode bypassPermissions` →
  `--dangerously-bypass-approvals-and-sandbox` (PR #36); the pleach seam passes that bypass
  to the codex auditor (`09f5beb`). The auditor completed its turn under the unattended
  conductor with no human present.
- **`partial` is now first-class** (`cdb2932`): the summary carries an (empty) `partial`
  bucket. A clean verified close, so nothing landed there — but a future honest-middle
  `partial` reads distinctly from `failed`.

This is the full **tend → pleach → verified** bridge proven against real claude builders,
a real codex auditor, and real tend — every check discriminated, every node closed.

## State

- **Full bridge proven (Run 3).** claude builds → codex audits → tend honest-middle
  verifies → pleach closes — every node green, against real agents + real tend. All four
  Run-2 open items are resolved (below).
- The honest-middle does its job in *both* directions: Run 2 (c2 had no negctrl) correctly
  capped at `partial`; Run 3 (c2 discriminates) correctly reached `verified`. Same
  guardrail, no special-casing.

## Resolution of the Run-2 open items

1. **Proof expectation vs payload** — ✅ c2 given a discriminating negctrl (`722fc40`); the
   payload reaches a full verified close (Run 3). README and payload now agree.
2. **Conductor `failed` vs `partial`** — ✅ distinct `partial` `RunSummary` bucket
   (`cdb2932`, test-first): a done-but-not-verified node no longer reads as `failed`, and
   the CLI maps `partial` to exit 1 (not success) via a pure `summaryExitCode`.
3. **umbel N8 (codex approval bypass)** — ✅ codex maps `--permission-mode
   bypassPermissions` → `--dangerously-bypass-approvals-and-sandbox` (umbel #36); the
   pleach seam passes it to the codex auditor (`09f5beb`). Both test-first.
4. **Step-node closure persistence across runs** — flagged to tend as **T1 / B1-B2**
   (jahala/pleach#9): tend owns feature-level closure + SHA persistence; pleach already
   anticipates it (`Map<id, sha|null>` + the `Set→Map` adapter) and degrades gracefully.
   Non-blocking; tracked cross-repo.

## P7 Phases Proof — calc (2026-08-16)

The `{test, phases}` TDD mode, previously covered only by in-memory loop
tests, proven at both rigor levels:

- **Case 0 (CI, deterministic):** `test/e2e/phases.test.ts` drives the cycle
  through the real CLI + real git with the scripted runner and REAL gate
  execution. The honest cycle closes; a CHEATING red phase (test already
  passes — no failing spec demonstrated) fails the node: exit 1, no branch,
  work quarantined. The TDD gate discriminates mechanically.
- **Real agent (manual, this machine):** a real claude session via umbel drove
  red→impl→green on a seeded broken `add()` (returns 0). pleach ran the RED
  gate itself (`bun test calc.test.ts` genuinely failed against the seed),
  the impl phase fixed the source, GREEN + smoke passed, `node/calc`
  published, verified close:
  `{"closed":["calc"],"failed":[],"partial":[],"skipped":[],"blocked":[],"quarantined":[]}`
  exit 0. Journal: run-start → node-start → verdict done → closed → run-end.
  The committed test is claude's own authorship (its formatting), not canned.

Constraint (documented in adapters.md + the pleach-plan skill): phases needs a
multi-turn runner — umbel, not `--runner direct-cli`.
