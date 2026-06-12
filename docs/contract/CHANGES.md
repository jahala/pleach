# Contract changes

- **v1.1** (2026-06-12) — initial pleach vendoring. v0.3 §1 + verification deltas: `Node.id` charset
  regex (SEC3); `Node.setup` (C3); `policy.timeoutMs` (D1); `Verdict.status += 'blocked'` (D2);
  `reauditWhen`/`budget`/`closes` annotated v1-inert (D6); `evidence.diffRef` documented
  required-on-close (B1/B2). Seam: `readClosed → Map<id, sha|null>`; `emitVerdict(v, source)`;
  `WorkerResult.reason` gains `input`/`idle`. Pending tend-side ratification — amendments land as v1.1.x.
