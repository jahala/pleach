# Competitor mining — Bernstein, gastown, loki-mode, Trellis (code-level)

**2026-08-18.** Three parallel researchers read real source (every claim carries file:line
in the session record), each briefed with pleach's current capability list so only genuine
gaps surfaced. Repos pinned: sipyourdrink-ltd/bernstein@main, gastownhall/gastown@649b832,
asklokesh/loki-mode@main, mindfold-ai/Trellis@main (+ the paddo.dev gastown field report).
Synthesis and the adoption calls are the lead's. Closed-source competitors (Devin, Factory,
Cursor, Codex) have nothing minable; claude-flow was previously established as
vocabulary-over-mechanism.

## The one-paragraph verdict

The field keeps converging on pleach's doctrine the hard way: Bernstein's early reviewer
fails open (outage → approve) while its newer verifier-ladder fail-closes `skip` — the
correction shipped side by side with the mistake; gastown let a merge agent classify red
tests as "pre-existing" and proceed (the auto-merged-failing-tests incident), then spent
months stripping LLM discretion out of its own kill path; Trellis's enforcement loop
degraded to agent self-certification when unconfigured, then was deleted entirely while
its docs still advertise it. **Every production failure across all three reduces to
fail-open defaults or LLM judgment in the close path** — the two things pleach's prime
invariant forbids. And still, each repo contains real, tested, deterministic machinery
worth taking.

## The adoption sheet (ranked, value-for-effort)

1. **Landing batch-verify + bisect** (gastown Refinery, `internal/refinery/batch.go`).
   pleach's one untested trust point: nodes verify on their own merged-from-deps trees,
   but the landed *combination* of sinks is never gate-tested. Port the shape into
   `landPlan`'s throwaway worktree: smoke the stack tip → one flaky retry → bisect with
   cumulative context (their `bisectRight` retests the right half atop the known-good
   prefix, catching order-dependent interactions) → re-verify the good subset → if THAT
   fails, merge nothing. Also steal: re-check-eligibility-immediately-before-push. Pure
   deterministic algorithm; zero doctrine friction. NOT their substrate: they build on the
   real target branch with `ResetHard` recovery (8+ sites) — the force-push-to-main
   factory; pleach's throwaway-worktree + ff-only stays.

2. **Deterministic retry escalation** (Bernstein `task_lifecycle.py:353-409` + gastown
   `redispatch.go:64-90` — two independent implementations converged). A pure function
   `(attempt, failureClass) → runnerParams`: attempt 2+ climbs models; budget/timeout
   failures re-run at higher effort, same model; typed reasons key the branches.
   Plan-declared (per-node `escalation` — a schema amendment, full contract ritual),
   code-decided. Pair with Bernstein's **closed corrective-template retry prompts**
   (`checkpoint_retry.py:91-109`): gate name + verbatim output + "do not redo work that
   already passed" — auditable re-prompts instead of freeform.

3. **Close receipts + the honesty ledger** (loki `proof-generator.py`/`proof-verify.py`
   + Bernstein's tri-state ladder receipts). Three-way convergence: (a) mint a per-node
   receipt at publish — canonical-JSON, sha256 integrity hash, facts sufficient to
   RE-DERIVE the verdict via `core/classify`; `pleach verify <node>` = rehash + re-derive
   + resolve diffRef; (b) `degraded[]`: every check the plan never configured, named — an
   ungated node must never be indistinguishable from a gated pass ("no coverage is not
   coverage"); (c) journal audit records go tri-state (pass/fail/skip) — an auditor outage
   is `skip`, and skip blocks. Carry loki's hard-won lesson verbatim: freeze the fact set
   at classify time (their verifier accused honest receipts of forgery over post-headline
   appends). SKIP their GPG/JWKS stack — git commit signing over pleach's verified SHAs
   already covers provenance.

4. **Diff-hygiene gate + empty-diff attribution** (Bernstein `janitor.py`,
   `guardrails.py`). Two real incident classes their archive documents: "verified but did
   nothing" (empty attributable diff rubber-stamped) and "verified but destructive."
   pleach's version is easier: the node's worktree diff vs merged base IS attribution —
   flag a non-command node closing with an empty diff; scan the staged diff for secrets
   (regex battery), protected paths, and a >50% single-file deletion tripwire. Pure
   git + regex, one more gate before publish.

5. **Typed refusal channel** (Bernstein `completion_contract.md`). A `refused` terminal
   state with a closed kind set: `scope_exceeded` (+ proposed split), `underspecified`
   (+ question), `blocked_on_dependency` (+ dep). Today an honest pleach worker that
   cannot proceed must fake done or burn attempts. Contract amendment; parsed evidence;
   deterministic routing.

6. **Token-budget circuit breaker** (loki `budget.ts` — the only project that ENFORCES
   budgets rather than declaring fields). Plan-level `maxTokens`: accumulate the telemetry
   the journal already carries, warn at 80%, deterministic halt at cap (stop scheduling;
   in-flight nodes finish to verdicts; journal + summary say so). Their doctrine detail:
   the fail-safe direction for an unknown rate is to stop sooner. Skip USD pricing tables
   (maintenance liability); tokens are provider-neutral and already measured.

7. **Context manifests + prose-by-reference** (Trellis's actually-good half). Optional
   per-node `context: [{file, reason}]` injected deterministically into the work order —
   attacks the top real failure of DAG'd agent work: a node not knowing the conventions
   its verified deps established. Plus: a work order may be a repo-relative file path
   instead of an inline string (reviewable plans, meaningful diffs).

8. **Auditor prompt: falsification framing** (Bernstein's adversary role — the best
   prompt in any repo surveyed). Add to `buildAuditPrompt`'s instructions when relaying
   findings: every finding must carry a falsification test ("if this passes, the finding
   closes — can't construct one? drop it"), `path:line` evidence, and structured escape
   hatches (`scope_too_large`, `unreviewable`). Prompt-only; no contract change.

9. **Cheap sweep-ups**: journal the runner's session id per node (human post-mortems —
   gastown's Seance reduced to its one good idea); a versioned closed `reasonCode`
   vocabulary on failure events; `git merge-tree` as an informational pre-landing
   conflict probe; ledger tests encoding "unconfigured gate = visible, never a silent
   pass" and "no code path deletes the only copy of unlanded work without a reachability
   proof."

## The never-import list (now with three repos of receipts)

- **Fail-open anything.** Bernstein: reviewer outage → approve. gastown: empty
  TestCommand → "no gates configured — pass by default." Trellis: every hook error path →
  allow; give-up at iteration 5 ships unverified work. The default posture of the entire
  field is open; pleach's closed posture is the moat.
- **LLM judgment in the close path.** gastown's merge agent may deem a red suite
  "pre-existing" and proceed; Bernstein's judge/intent gates; Trellis's self-emitted
  completion markers. Includes any future "flaky-test classifier" — bisect IS the
  deterministic replacement for that judgment.
- **Prompt-text guardrails as gates.** "NEVER run tmux kill-session" as instructions to a
  model preceded gastown's murdered worktrees; the real fixes were Go preconditions with
  git-ancestry proofs. A prompt is a request; a gate is code.
- **Destructive authority without machine proof; mutable shared targets; always-on LLM
  patrol loops** (gastown's $100/hr was agents polling for liveness — anything with a
  deterministic answer must cost zero tokens).

## Sequencing note

Items 2, 5, 6, 7 touch the plan schema → each is a contract amendment with tend2
ratification; batch them thoughtfully (one v1.2 conversation, not four v1.1.x dribbles).
Items 1, 3, 4, 8, 9 are pleach-internal and can land independently. Nothing here is
urgent-over-launch: the sheet is a post-launch quality ladder, except item 1 (landing
verify) which arguably belongs before serious external use — it is the last place pleach
trusts without testing.
