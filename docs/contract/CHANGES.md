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
  ; explanatory companion:
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

- **Receipt, not schema (2026-09-10)** — the receipt file's `artifacts?` gained `handback?`: the
  message the worker handed the work back with, kept verbatim beside the receipt at
  `<git-dir>/pleach/receipts/<node>.handback.md` on every close, done or quarantined (ledger D17 —
  until now it lived only in the provider's own session, which the runner kills moments later).
  Kept, never read: pleach hashes the bytes and names the file, and nothing in pleach parses a word
  of it. Additive, and outside the contract: `@agent-contract/plan` is untouched — no schema-block
  change, no version bump, drift guards unaffected, nothing for tend or umbel to re-vendor. The
  hashed envelope is untouched too (`artifacts` sits beside `refs`, settled after the freeze), so
  every receipt already on disk still verifies.

- **Seam prose, not schema (2026-09-10)** — `Worker.wait`'s opts gained `idleMs?: number` in the
  informative "Seam interfaces" block: the conductor's idle policy, handed to the runner so a
  wedged worker ends at an idle timeout instead of riding the attempt clock (ledger D16; the
  umbel adapter passes it as `--idle-timeout`, the CLI default is `--idle-ms`, ten minutes).
  Doc-only and additive: `@agent-contract/plan` is untouched — no schema-block change, no version
  bump, drift guards unaffected. A runner that cannot detect idleness ignores the field and
  behaves exactly as before. The `idle` reason it produces is the one `WorkerResult.reason` has
  always carried, and its mapping (blocked, prompt text as `blockedReason`) is unchanged.

- **Receipt, not schema (2026-09-10)** — the receipt store keeps every close of a node instead of one
  per node id (ledger D17). Each write lands `<git-dir>/pleach/receipts/<node>.<sha256 prefix>.json`,
  the close's own record, beside `<node>.json`, whatever closed last; `refs.previousReceiptSha256`
  already linked one close to the next, and `pleach receipt <node>` now verifies the latest and lists
  the history it walks. Kept artifacts follow the same two names, so `artifacts.sarif` (and
  `.friction.jsonl`, `.handback.md`) is the path of THAT close's file — the un-prefixed name holds the
  same bytes for the latest close only. Additive, and outside the contract: `@agent-contract/plan` is
  untouched — no schema-block change, no version bump, drift guards unaffected, nothing for tend or
  umbel to re-vendor. The hashed envelope is untouched too, so every receipt already on disk still
  verifies. Recorded here because the umbrella's predicate (`predicate.weeder.sarif.sha256`) reads the
  artifact path out of a receipt: read it from the receipt, never by guessing the node's name.

- **Receipt, not schema (2026-09-10)** — the close receipt's facts gained `base?: { kind:
  'quarantine', sha }`: the tree a close was seeded from when it did not build its own (ledger D17).
  `pleach audit <plan> <node>` re-runs only the audit on a quarantined node whose build was green,
  checking the quarantined tree out again, so its close must stay distinguishable from a fresh
  build's forever — the umbrella's predicate has to be able to tell a re-adjudicated close from one
  whose gates all ran on the tree that close made. `pleach run` records it for the same reason: a
  pending node whose `quarantine/<id>` resolves resumes from that tree by default (`--fresh` opts
  out), and while every gate re-runs over it — a quarantine was never gated — the close still stood
  on work an earlier attempt left behind, and says so. Additive, and outside the contract:
  `@agent-contract/plan` is untouched — no schema-block change, no version bump, drift guards
  unaffected, nothing for tend or umbel to re-vendor. Sealed INSIDE the hashed envelope (unlike
  `refs`/`artifacts`), because what was judged is a fact of the close rather than a ref settled
  after the freeze; `canonicalJson` drops undefined, so every receipt already on disk hashes exactly
  as it did and still verifies. `deriveStatus` does not read it: seeding from a quarantine changes
  what a close stood on, never what its facts imply.

- **Receipt, not schema (2026-09-10)** — the close receipt's facts gained `redSealedAt?: number`: the
  index of the red phase whose seal is in the tree that close held (ledger D13/D17). A `{test, phases}`
  node resumed from `quarantine/<id>` re-enters its work list after that phase, because a tree that
  already carries the failing test cannot demonstrate it failing again — re-running the phase either
  seals a lie or, over a tree nothing changed in, ends the node on a commit with nothing to commit.
  The fact travels with the tree: `pleach run` reads it from the same receipt that vouched for the
  quarantine, and `pleach audit` copies it onto the close it writes, the tree it judged being that
  tree. The index is only ever read against the list the plan carries NOW: one that no longer names a
  red phase there refuses the seed (`resume-refused`) and the node builds its own tree, because
  re-entering after a phase the plan has moved would skip a phase that never ran. Additive, and
  outside the contract: `@agent-contract/plan` is untouched — no schema-block change, no version
  bump, drift guards unaffected, nothing for tend or umbel to re-vendor. Sealed INSIDE the hashed
  envelope like `base`, because an index edited afterwards would skip a red phase;
  `canonicalJson` drops undefined, so every receipt already on disk hashes exactly as it did and
  still verifies. `deriveStatus` does not read it: where a tree left off changes what an attempt
  runs next, never what a close's facts imply.
