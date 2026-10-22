# pleach roadmap: the open issues as work packages

**You are here (2026-10-22).** v1.0.0 is released. The audit fixes (D24–D27) and the first P1 batch
(D28 #98, D29 #147, D30 #148) the second batch (D31 #114, D32 #131, D33 #149) the third (D34 #151, D35 #127, D36 #146 with #126) the fourth (D37 #107, D38 #152, D39 #154, D40 #128) and the fifth (D41 #106, D42 #109, D43 #115, D44 #123, D45 #100) are merged, and CI runs the umbel suites. Every open issue carries a
priority label: P1 loses work or blocks a run, P2 costs time or misleads, P3 is polish. This page groups
the open issues into work packages that share code and need one design, in the order to build them.
Each package becomes a tend2 loop when work starts, with a ledger item for each defect.

## Order

| # | Package | Issues | Why this position |
|---|---|---|---|
| 1 | Nothing unjudged, nothing unrecorded | #125 (then #129); #131, #127, #109 done (D32, D35, D42) | Work that no gate judged, or that the record lost, can reach a verified branch. This is the prime invariant. |
| 2 | The operator's seat | #63 #86 #71 #87; #114, #115 done (D31, D43) | The largest field pain: 806 `tail` polls across 25 sessions, and sessions killed by hand. |
| 3 | Casting and the config | #149, #146, #126, #128 done (D33, D36, D40) | Found dogfooding on cfanalytics: one plan cannot reach two endpoints of one CLI, and an ordinary audit command costs a whole build before it fails. |
| 4 | Landing that finishes the job | #124 #116 #85 #130; #116's replay design was tried and rejected (see the issue) | One small honesty fix first. Then land stops handing conflicts to a person. |
| 5 | Contract v1.2, one round with tend2 | #113 #104 #90; #123, #106 done (D44, D41) | Schema changes batched into one conversation once tend2 is public. The receipt version fence is an open decision for the owner. |
| 6 | Umbrella fit | #108 #112 | Small, and they need plotplot's contracts. |
| — | Blocked or parked | #111 (umbel#92) · #117 (an experiment outside this repo) · #70 (needs a design); #107 done (D37) | See below. |

## 1. Nothing unjudged, nothing unrecorded

**Code:** `loop/run-work.ts` (the phase loop), `loop/run-node.ts` (the attempt loop and the smoke gate),
`seams/isolate.ts`, `adapters/umbel.ts` (reading the worker's reply).

- **#131:** a failed gate's writes stay in the tree, the retry inherits them, and they get published. A
  passing gate's writes are never collected. Done in D32: the tree is restored after a failed gate.
- **#127:** umbel reports `stop` while the worker's own background command is still writing, and the gate
  judges a half-written tree. Done in D35: the tree settles before a gate.
- **#125:** a phased node keeps only the last phase's closing message.
- **#109:** a failed `umbel read` silently becomes an empty handback. Done in D42: the close keeps a handback naming the failure.
- **#129** (later): gates re-run on a tree that has not changed since the last run.

**The unifying design is a tree fingerprint at the attempt boundary** (a `git write-tree` over the
working tree). #127: when the worker stops, wait until the fingerprint holds steady before any gate runs.
#131: take the fingerprint before each gate, restore the tree after a failed gate, and collect a passing
gate's writes on purpose. #129 later keys proof records by the same fingerprint. D24 already pins the
committed tree, so this closes the other end. #125 and #109 change the same phase loop, so they ride along.

## 2. The operator's seat

**Code:** `core/journal-envelope.ts` (the event kinds), `faces/narrate.ts`, `faces/cli.ts` (new verbs),
`loop/run-plan.ts` and `loop/run-node.ts` (what gets appended), `adapters/umbel.ts` (session names).

- **#114 (P1):** `pleach status` and `pleach wait`. Done in D31.
- **#63:** events for each gate and each audit check, with the output tail.
- **#86:** `run-start` names the already-verified nodes.
- **#71:** sessions named by plan and node.
- **#115:** `clean` kills the run's leftover sessions. Done in D43: the journal names each session, and `clean` reaps those never killed.
- **#87:** the build's commit recorded beside its version.

**Design once: the journal is the only source of truth for run state.** Define the event vocabulary
(gate start and end with output tail, audit check, phase, spawn with session name, run-start with the
verified set and build), then make status a pure fold in `core/` from journal to state. `status` and
`wait` are faces over that fold, and `clean` reads the spawn events to find sessions. No second state
store.

## 3. Casting and the config

**Code:** `faces/config.ts`, `core/validate.ts`, `adapters/umbel.ts`, `core/audit-egress.ts`, the
`pleach-plan` skill, `docs/adapters.md`.

- **#146:** a named cast in the config (`casts: { deepseek: { provider, model, env } }`) that a node names
  in `worker.provider`, so one plan reaches two endpoints of one CLI. `validate` then refuses a provider that
  is neither known nor declared, which catches typos such as `cluade`. Done in D36.
- **#126 (S):** pass env values by name only (`--env KEY`). Casts put secrets in env, so this lands first. Done in D36.
- **#149:** an `accept.audit.command` must print a `tend-audit-result` block, but nothing a planner reads
  says so. Ship a wrapper that turns any check into that block, and say so in the schema and the skill. Done in D33: `pleach audit-wrap`.
- **#128 (S–M):** a spawn that exits 126 means a person must sign in. Settle it `blocked` with that next
  step, and never retry it on the same provider.

## 4. Landing that finishes the job

**Code:** `loop/land.ts`, `seams/isolate.ts` (`landStack`, `publish`), `core/errors.ts`.

- **#124 (S):** a land-gate refusal names the command but drops the output tail it already journals.
- **#116 (L):** on a conflict with a sibling, rebase the node onto the landed stack in a fresh worktree,
  re-gate it there, and land on green. Journal it as `land-rebase`. Tried 2026-10-22 and rejected: a cherry-pick shares the merge's base, so it rarely resolves anything, and where it did apply it dropped a sibling's verified line. The way forward is to rebuild the conflicting node on the landed tip; see the issue.
- **#85:** `run --only`. `land --sinks` already shipped (D18).
- **#130:** "published" and "landed" are local-only. Say so, and report how many verified branches exist
  on no remote.

## 5. Contract v1.2, one round with tend2

**The receipt version fence is open.** D44 moved the contract to v1.1.6 with the fence as it stands, so
every receipt minted under v1.1.5 now fails `pleach receipt`, although nothing it derives from changed.
Proposal: verify each receipt against the contract version it names, and refuse only versions this
build does not know. Accepting older receipts is a backward-compatibility change, so it waits on the
owner's approval.

Then batch the changes into one round:
- **#123:** a test that fails when the contract text changes without a version bump. Done in D44 (v1.1.6).
- **#106:** a `reason` and `nextStep` on every verdict that doesn't close. Done in D41, journal-only.
- **#113:** a red phase that already exists.
- **#104:** document the green-only proof shape.
- **#90:** effort in the cast.
- The four amendments already drafted in `docs/contract/v1.2-proposal.md`.

## 6. Umbrella fit

- **#108:** a `garden.json` manifest.
- **#112:** a test that cites plotplot's `contracts/delivery.md` and covers whole-map artefacts that land
  must re-earn.

## Blocked or parked

- **#107 (P1), redaction.** plotplot#52 has shipped `plotplot redact` (stdin to stdout, fails closed).
  Wiring it in makes the plotplot binary a dependency of a tool that otherwise needs only git and a runner,
  and someone must decide what a run does when the binary is missing. That is the owner's call. Done in D37: `plotplot redact`, fail closed, explicit `--no-redact`.
- **#111:** a read-only auditor needs umbel#92.
- **#117:** the typed-judge audit is a calibration experiment run elsewhere; no code yet.
- **#70:** re-reading the plan mid-run conflicts with a run's plan being fixed. Design it after package 2,
  whose journal would record the change.

## Partly done (issue text needs updating)

- **#85:** `land --sinks` shipped (D18). `run --only` has not.
- **#87:** the version now reads 1.0.0 from `package.json`. The build commit is still missing.
- **#104:** the schema already allows a green-only phase, and `docs/dogfood/make-plan.ts` emits it. Only
  the docs are missing.
