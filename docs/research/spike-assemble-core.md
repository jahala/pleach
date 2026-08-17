# Spike: assemble-core — the first conducted agent build in a stranger repo

**2026-08-17, terminal state: VERIFIED GREEN.** The joint tend2 × pleach spike, owner-mandated,
converged on-channel (protocol + kill criterion upfront). One node — assemble-core, a real
client-side PDF engine (merge / reorder / image-import) from tend2's pdf-unifier forest — built
by a conducted claude worker in a scratch consuming repo (`/Users/jahala/spike-pdf-unifier`)
belonging to neither agent, gated by tend2's verifier with a content-pinned payload.

## Result

- `node/assemble-core` published @ `dea0eda`: 24 files, 3,144 insertions — pdf-lib engine,
  vitest suites, the toolchain the worker installed itself. 885 s wall clock, attempt 1.
  master untouched.
- **Independently confirmed**: fresh detached worktree of the committed branch, verifier re-run
  with the pin — exit 0; five code checks green; agent/human checks correctly skipped
  (un-workable lanes by design).
- **Interventions: 1 of the allowed 2** (an account switch after run 1's worker died twice —
  environment, not work; `dead` classification, fresh-tree resume, and the no-quarantine-on-
  empty-diff rule all behaved per contract, an accidental live datapoint for the failure story).

## Claims scorecard

| claim | result |
|---|---|
| a tend2-emitted plan runs through pleach unmodified — agent lane | PROVEN |
| workers never touch the loop file; verifier-only stamps hold under real agents | HELD |
| the payload pin survives worker self-runs of the gate (same-day fix) | HELD under live fire |
| worker ≠ auditor diversity | NOT TESTED (smoke-gate lane; declared upfront) |
| terminal failure yields a human-reconstructible story | live datapoint from run 1 (dead lifecycle) |
| finished loop pages as the highlightable example, real stamps | EXISTS — owner-reviewable |

## Findings (4 before any worker ran — the spike paid pre-launch)

1. A format-legal SAMPLE page (visual-vocabulary) hijacked forest routing as a real failure —
   tend2 product defect, fix queued their side.
2. emit-plan emits nodes for loops whose workable set is empty (a needs-you-only loop would
   ship a checkless work order) — fix queued their side.
3. **Both agents' owner guard hooks blocked the repo-init command identically and neither
   routed around them** — the system escalated venue creation to the human, who ran the
   one-liner himself. The shared laws held against their own authors.
4. direct-cli reports no token telemetry — the casting ledger's first real feed is
   duration + attempts only (honest-partial; umbel lane carries tokens).

Map-side story: tend2's repo (cross-linked from their loop pages). Landing the branch is one
command (`pleach land`), owner-timed, per the leave-for-review call.
