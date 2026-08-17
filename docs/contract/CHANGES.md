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
