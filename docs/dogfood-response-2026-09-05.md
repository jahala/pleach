# Response to bandung's dogfood report — findings validated, tasks planned

Source: `weed/bandung/docs/dogfood-report-2026-09-05.md` (pleach at 8f8f12b — this tree).
Every finding was re-checked against the code, not the report's word. Verdicts first, then
the task plan.

## Validation verdicts

| # | Claim | Verdict | Ground truth |
|---|-------|---------|--------------|
| P1 | Dead verdict carries no evidence — no receipt, no quarantine | **CONFIRMED** | Two stacked causes. `run-node.ts:225` returns a bare `status:'dead'` verdict — no gate record, no runner detail. Then `run-plan.ts` mints the receipt but `quarantineOrJournal` early-returns on a clean tree (`changed.length === 0`, line 238) *before* the receipt write, so an 8-second death with no file changes leaves nothing at all. Exactly what bandung saw. |
| P2 | A blocked node keeps nothing | **CONFIRMED** | `run-node.ts:205` disposes the tree on blocked ("the worker never finished a turn, there is nothing worth keeping"). The rationale is wrong: workers edit files *during* a turn — 9m40s of work sat in that tree. The generic `blockedReason` is umbel's wait message passed through faithfully (their U5 owns making it specific). |
| P3 | An unrunnable audit burns a worker retry | **CONFIRMED** | `AuditResult.verdicts[].verdict` is `pass\|partial\|fail` — no "could not run" class exists, so a verifier error is indistinguishable from a check failure, classifies retryable, and re-prompts a worker who can change nothing about the auditor's command. Needs a contract amendment; text-sniffing the reasons is off the table (parsed, never interpreted). |
| P4 | Landing from quarantine sits outside the ledger | **CONFIRMED** (stance chosen) | True: no `node/<id>` is published by a hand-merge. Taking the report's second option — the documented stance — not the verb. Rationale below. |
| P5 | Killing a run leaves parts behind | **CONFIRMED** | Zero `process.on`/`SIGTERM`/`SIGINT` handlers anywhere in `src/`. No clean verb. Stale-lock takeover is the only mitigation, as observed. |
| P6a | `--version` is an unknown flag | **CONFIRMED** (reproduced) | `bun src/main.ts --version` → `pleach: unknown flag '--version'`. |
| P6b | `--help` says `<repo-root>/.git/pleach/…` | **NOT REPRODUCIBLE at 8f8f12b** | The help already reads `<git-dir>/pleach/journal.jsonl` (`cli.ts:48`, fixed in the D8 era). Their installed global bin may predate it. |
| P6c | Narration prints the whole goal paragraph | **CONFIRMED** | `narrate.ts` interpolates `e.goal` untruncated on both `run-start` and `land-start`. |
| P6d | v1.3 Tried-handback not in `pleach schema` | **CONFIRMED, by design** | Contract is still v1.1.5; the v1.2 batch (escalation/refusal/budget/context) is ratified-but-unimplemented. Tried-handback joins the amendment queue, it doesn't jump it. |
| P6e | Trust prerequisite undocumented | **CONFIRMED** | README says nothing about Claude Code folder trust following the main checkout. |

The report's headline holds: three of four early runs died on tool edges, zero on the work,
and the receipts/journal made the diagnosable failures one-minute reads. The sharp edges are
real and specific.

## Tasks, in order

### T1 — Terminal settles always leave evidence (P1 + P2, one change)
The doctrine: *no terminal verdict without an artifact.* Three parts, one PR, RED-first,
ledger D11.
1. **Receipts decouple from the quarantine commit.** Mint AND write on every terminal
   settle (`failed`/`dead`/`timeout` — and `blocked`, below) even when the tree is clean or
   the quarantine commit fails; `refs` stays absent when nothing was committed (the design
   already allows it). The trailer only ever rides commits that exist.
2. **Blocked quarantines like failed.** `run-node` stops disposing the blocked tree and
   hands it back; settle's blocked branch runs the same quarantine + receipt + dispose
   sequence (`facts.status: 'blocked'`, derived `quarantined`). Unfinished is not wrong —
   but it is worth keeping.
3. **Dead verdicts carry what the runner knows.** The dead path gains a gate-style record
   (`ran: 'wait:dead'`) in verdict + receipt, and `WorkerResult` gains optional
   `paneTail?`/`processExit?` passed through to the journal when present — the pleach half
   of umbel's U3 (pane-capture-at-death, already escalated to the owner 2026-08-20; this
   report is the recurrence evidence). Fields optional, so it lands before umbel's half.

### T2 — Audit "could not run" class (P3; contract amendment, coordinate with tend2)
`AuditResult.verdicts[].verdict` gains `'error'` (or a sibling field — shape to be agreed
with tend2, whose verify emits it and whose `emit-plan --runner` bug is the trigger's other
half). Loop honor: when every failing record is could-not-run, settle terminal as a plan
defect — no worker re-dispatch, no retry burn, distinct journal reason. Rides the standing
amendment queue with the v1.2 four and Tried-handback; one coordination round with tend2
re-scopes the batch instead of drip-feeding schema changes.

### T3 — Graceful teardown + `pleach clean` (P5; revives the crash-safe-worktrees design)
SIGINT/SIGTERM at the face: kill live workers, dispose worktrees/stacks, release the lock,
journal `run-aborted`. Plus a `pleach clean` verb: dispose orphaned pleach worktrees
(ancestry-checked), clear stale locks, LIST leftover umbel sessions (killing them is
umbel's jurisdiction). Folds in the parked `<git-dir>/pleach/worktrees/` relocation so
orphans stop living in the OS temp reaper's shadow.

### T4 — Small fixes (P6, one small PR)
`--version` prints the package version · narration clamps the goal to its first sentence
on `run-start`/`land-start` · README gains the one-line trust prerequisite (trust follows
the main checkout, not the worktree) · P6b needs nothing (already `<git-dir>`; tell
bandung to rebuild their global bin).

### T5 — Quarantine hand-landing stance (P4; docs only)
Document in README's landing section: the map is the ledger — a hand-landed quarantine is
followed by re-emission (tend2's emitter already drops fully-stamped loops, which is why
bandung's case self-healed). The `--from-quarantine` verb waits for recurrence data; with
T1+T2 shrinking false quarantines, most of its demand should evaporate. Recorded so it's
revived by evidence, not re-argued.

## Not pleach's, tracked elsewhere
U1 (trust-dialog default flipped in Claude 2.1.261 — the killer of runs 1–2), U2, U3
(umbel half), U4, U5, U6 → umbel. `emit-plan` audit-runner omission + questions file →
tend2 (bandung has already routed both). T1.3 and T2 are the two seams where my build
consumes their outputs; interface notes go on-channel when those tasks start, not before.
