# Contract changes

- **v1.1** (2026-06-12) — initial pleach vendoring. v0.3 §1 + verification deltas: `Node.id` charset
  regex (SEC3); `Node.setup` (C3); `policy.timeoutMs` (D1); `Verdict.status += 'blocked'` (D2);
  `reauditWhen`/`budget`/`closes` annotated v1-inert (D6); `evidence.diffRef` documented
  required-on-close (B1/B2). Seam: `readClosed → Map<id, sha|null>`; `emitVerdict(v, source)`;
  `WorkerResult.reason` gains `input`/`idle`. Pending tend-side ratification — amendments land as v1.1.x.

- **v1.1.1** (2026-06-12) — tend-side ratification applied. `Node.id` grammar replaced (contest
  accepted): dot-separated alnum/_/- segments + `.lock`-suffix refine — the v1.1 regex admitted `:`,
  `..`, and `.lock`, all refused by `git check-ref-format`; `.` is the composite separator
  (`<feature>.<step>`). `Verdict.evidence.blockedReason` added (the blocking prompt text). Binding
  prose added: setup-failure semantics, 30m timeout default + blocked-preempts-timeout, resolved-provider
  diversity check, single-writer-during-run, ingester-enforced diffRef, advisory evidenceSha, work-union
  mapping pin. Ratification record: missoula docs/internal/bridge/tend-umbel-v1.1-ratification.md.

- **v1.1.2** (2026-06-18) — `accept.audit.model` added (optional): pins the cross-provider
  auditor's model, mirroring `worker.model`. The provider-diversity rule is unchanged —
  `accept.audit.provider` must still differ from the worker provider. Backward-compatible:
  omitting it preserves the prior behaviour (the runner picks the provider's default model).

- **v1.1.3 (2026-08-17 — tend2-ratified same day, on-channel)** — binding-prose-only: adds the
  "Shared law" section (LAW 1: the checker must not be writable by the checked; LAW 2: status is
  computed, never asserted), with instances from both implementations. No schema-block change;
  drift guards unaffected. Converged in the tend2 × pleach walkie dialogue 2026-08-17
  (archive: docs/research/walkie-dialogue-2026-08-17.md); explanatory companion:
  tend2 docs/bridge/working-together.md.

- **v1.1.4 (2026-08-17 — tend2-ratified same day, on-channel)** — binding-prose-only: "Exec
  semantics" pinned — plan-authored command strings exec argv-style with NO shell; bare
  shell-operator tokens are refused loudly (escape hatch: `bash -lc '…'`). Found by the joint
  canary's first run: tend2's emitter assumed shell semantics, pleach's arg-array exec turned
  `&&`/`>` into literal mkdir arguments (exit 0, silent garbage). No schema-block change.

- **v1.1.5 (2026-08-17 — tend2-ratified same day, on-channel, against 7239484)** — `accept.audit.selfIntegrity?:
  boolean` (backward-compatible optional) + "Self-integral audits" binding prose: a declared
  command self-checks its audit target's fitness-function integrity (scoreboard-normalized pin)
  and resolves out-of-tree; the conductor's argv-token tamper rule stands down for it. Fix for
  the phase-2 hub collision (writing verifier × tamper heuristic — finding #10).

- **Receipt, not schema (2026-09-10)** — the close receipt's `GateRecord` gained `artifactSha?` (the
  sha256 of the findings log a gate printed on stdout, D14) and the receipt file gained `artifacts?`
  beside `refs` (where what the tree held was kept: the log at
  `<git-dir>/pleach/receipts/<node>.sarif`, the worktree's friction journal at `<node>.friction.jsonl`).
  Additive, and
  outside the contract: `@agent-contract/plan` is untouched — no schema-block change, no version
  bump, drift guards unaffected, nothing for tend or umbel to re-vendor. A receipt that kept no
  artifact hashes exactly as it did before the field existed (`canonicalJson` drops undefined), so
  every receipt already on disk still verifies. Recorded here because the receipt is the surface the
  umbrella's predicate (`predicate.weeder.sarif.sha256`) cites.

- **Seam prose, not schema (2026-09-10)** — `Worker.wait`'s opts gained `idleMs?: number` in the
  informative "Seam interfaces" block: the conductor's idle policy, handed to the runner so a
  wedged worker ends at an idle timeout instead of riding the attempt clock (ledger D16; the
  umbel adapter passes it as `--idle-timeout`, the CLI default is `--idle-ms`, ten minutes).
  Doc-only and additive: `@agent-contract/plan` is untouched — no schema-block change, no version
  bump, drift guards unaffected. A runner that cannot detect idleness ignores the field and
  behaves exactly as before. The `idle` reason it produces is the one `WorkerResult.reason` has
  always carried, and its mapping (blocked, prompt text as `blockedReason`) is unchanged.
