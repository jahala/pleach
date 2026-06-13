# P6 Proof Run — wordcount

First real execution of the conductor against real agents (claude builders, codex
auditor) + real tend (missoula ingester), on the `examples/proof` wordcount payload.
Per ENGINEERING.md §P6: the run names the next defect; we fix it RED-first.

Setup: `examples/proof/project` copied to a throwaway git repo, `pleach run` with
`--repo-root <copy> --tend-module …/missoula/src/core/bridge/ingester.ts
--max-concurrency 2`, real `rctrl` binary on PATH.

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

## State

- **Defect #1 (audit egress relay): FIXED, tested, verified.** The proof's purpose —
  demonstrating the full claude-builds / codex-audits / tend-gates pipeline with a
  parseable, machine-checked audit — is achieved.
- The terminal `partial → not verified` is the designed honest-middle, not a failure of
  the system.

## Open items (decisions / follow-ups, not blockers)

1. **Proof expectation vs payload.** README §"What success means" criterion 3 expects
   tend to flip wordcount to `verified`, but the payload's c2 (no negctrl) caps the
   feature at `partial` — these contradict. To demonstrate a *full verified close*, give
   c2 a negctrl so every check is pass+discriminated. To keep demonstrating the
   honest-middle, fix the README to expect `partial`. (Proof-design choice, not a code
   defect.)
2. **Conductor: `failed` vs `partial`.** A node that is `done` but not-closed because
   tend honestly returns `partial` is lumped into `failed` in the run summary. Consider a
   distinct `partial`/`not-verified` outcome so an honest-middle result reads differently
   from a real failure.
3. **rctrl N8 (codex approval bypass).** Latent — did NOT block this run (codex completed
   its audit turn), but the rctrl seam deliberately gives codex no permission bypass and
   a manual repro showed codex *can* prompt for command approval. Worth a per-provider
   permission primitive for robustness against codex configs that require approval.
4. **Step-node closure does not persist across conductor runs** (s1/s2 re-ran on run 2).
   Expected pre-T1 (tend records feature-level closure; SHA persistence is tend's pending
   work, which pleach already anticipates via `Map<id, sha|null>`).
