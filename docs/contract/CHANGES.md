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
  mapping pin. Ratification record: missoula docs/internal/bridge/tend-rctrl-v1.1-ratification.md.
