# Dogfood — record-survives (D21, jahala/pleach#96 #97 #93)

What the pleach agent hit in tend2, pleach, umbel, weeder and pollen while conducting this loop.
The shaping-pass findings that apply to every loop of the 2026-09-08 order are recorded once in
`test-phase-commit.md`; this file carries what this loop's run added.

## Conducting (2026-09-12)

Run: `pleach run docs/dogfood/record-survives/plan.json --repo-root . --max-concurrency 1`, twice:
the first run settled rs.blocked-md `blocked` and ended with two nodes skipped; the second run
resumed it from its quarantine and finished. Workers claude-opus-5 through umbel, smoke
`weeder check --strict`, audit = tend2 verify on the node's check as a self-integral audit run by
opencode + deepseek/deepseek-v4-pro. Result: 7 of 7 nodes verified in 9 attempts; landed by
`pleach land` (fast-forward, land gate green) onto feat/record-survives at 3d1f3c0; `bun run check`
green (771 tests); every check stamped by `tend2 verify`.

Conducted under D13, D14, D16, D17, D18 and D19. The first live resume from a quarantined tree
happened here (D17): rs.blocked-md's second receipt seals `base` as the quarantine sha.

| node | check | attempts | wall | what the extra attempt was |
|---|---|---|---|---|
| rs.snapshot | c1 | 1 | 12m38s | — |
| rs.commit-refused | c2 | 1 | 13m44s | — |
| rs.journal-gap | c3 | 1 | 13m21s | — |
| rs.run-copy | c4 | 1 | 13m08s | — |
| rs.blocked-md | c5 | 1 + 1 | 25m03s + 15m18s | attempt 1 settled blocked (a subagent wait read as idle); the re-run resumed from the quarantine |
| rs.docs | c6 | 1 | 9m09s | — |
| rs.e2e | c7 | 2 | 16m48s | the RED gate refused a proof that already passed; the retry found the BLOCKED.md check had to run after a non-stop wait too |

### Findings, per node
### rs.snapshot (verified, 1 attempt(s), 758s, audit pass)
- IsolateSeam.snapshot = write-tree → commit-tree -p HEAD → update-ref (core.hooksPath=/dev/null for good measure); the "used by worktree" refusal is kept via `git worktree list --porcelain -z`, so quarantine's .2/.3/.4 fallback still works; quarantineOrJournal uses snapshot. Proven against a real repo whose pre-commit refuses everything. Two live set-asides on this node (the worker's .loop-scratch/hook-probe.ts). Reviewed. #96's quarantine half lands here.

### rs.commit-refused (verified, 1 attempt(s), 824s, audit pass)
- commitVerified() → {committed} | {refused, gate, outcome}: a refused commit (or late markers) becomes a failed outcome with gate 'commit'/'marker' and the hook's output as the tail, then takes the ordinary non-done path — receipt minted from the failed facts, quarantine by snapshot, dispose AFTER; gate-fail journaled. No more dispose-then-forget. Reviewed. #96 closes with the merge.

### rs.journal-gap (verified, 1 attempt(s), 801s, audit pass)
- ReceiptStore.list() (latest receipts, closedAt = the file's mtime, unsealed and named so) + JournalSeam.hasVerdict(node); on run-start every receipt with no verdict line journals `journal-gap` {node, receiptSha256, closedAt}; a listing failure journals `journal-gap-check-failed` and never fails the run; both run.lifecycle. Live weeder catch: `weeder check --strict` flagged S2 (an error swallowed without a stated reason) on the seam's parseLine and the worker fixed it before the GREEN gate. Reviewed. #97's gap half lands here.

### rs.run-copy (verified, 1 attempt(s), 787s, audit pass)
- runId = run-start's ISO time (colons → dashes) journaled on run-start; run-end carries journalCopy (receipts/runs/<runId>.journal.jsonl) BEFORE the copy is written from JournalSeam.linesSince(runId); a missing run-start is a typed error caught into a journal line, never fatal. Reviewed. #97's copy half lands here.

### the shared binary (from cape-town, 2026-09-12)
- ~/.bun/bin/pleach is a bun link into THIS checkout (cayenne/src/main.ts): every conductor any agent runs executes my working tree as it stands at that second. The umbrella's first conducted node failed inside isolate on a nonexistent path while my tree sat mid-node on feat/record-survives. cape-town runs a pinned clone by path now; the lock-pinning of conductors is filed on jahala/plotplot with a comment on pleach#87 (the conductor's build invisible in the record — exactly the case). Not mine to change (the link is the machine's); worth knowing before any branch switch mid-day.

### rs.blocked-md — attempt 1 BLOCKED (25m, blockedReason null, paneTail empty, no handback)
- The quarantine holds only a 13-line harness.ts edit: the worker did little in 25 minutes and then the wait ended `idle` (the 10-minute --idle-ms from D16 — a wedge caught by the timeout, as designed) or `input`; umbel reported no prompt text. Re-running: D17 resumes from quarantine/rs.blocked-md.
- Cause, from the worker's own transcript (cost-state: 252 s of API time in a 1503 s session; "Check SpawnCtx usages outside harness" as a subagent description): the worker launched a subagent and waited on it; the tmux pane did not change while the subagent worked, so umbel's idle detection — pane-based — reported `idle` after --idle-ms (10 min) and pleach settled the node blocked with no reason text (umbel's idle answer carries none). D16's timeout did its job; the wedge was the worker's subagent wait looking idle. → comment on umbel#67. Re-run resumes from quarantine/rs.blocked-md (D17).
- Re-run: `resumed-from-quarantine` {node: rs.blocked-md, sha: e90fa7e} — the FIRST live resume from a quarantined tree (D17); the four verified nodes skipped by the ledger.

### rs.blocked-md (verified on the resumed tree, attempt 1 of the re-run, 918s, audit pass)
- Its receipt seals base {kind: quarantine, sha: e90fa7e} and redSealedAt 0 — the first receipt of a resumed close; node/rs.blocked-md reads quarantine → red → verified. IsolateSeam.readBlocked; run-node settles blocked at once with the file's text (capped 4000; an empty file gets an explicit marker) and the tree quarantined; the phased ladder checks for BLOCKED.md after each phase too (wroteBlocked); the re-prompt says it starts from the prompt alone. Reviewed. #93 closes with the merge.

### rs.docs (verified, 1 attempt(s), 549s, audit pass)
- journal.md: journal-gap, journal-gap-check-failed, run-start runId, run-end journalCopy, blocked via BLOCKED.md; README states the three behaviours. Reviewed.

### rs.e2e (verified, 2 attempts, 16m48s, whole-page audit 7/7 pass)
- Attempt 1 was refused by the RED gate (the proof already passed against the landed siblings). The retry's honest red: a worker that wrote BLOCKED.md and then ended its wait with a non-stop reason (input/idle) was settled by that reason, not by the file; `settleIfBlocked` now runs after a stop and after a non-stop wait alike (never after dead or aborted). Eighth time this week the gate turned an already-green test into a real defect.
- Two real-CLI scenarios: a pre-commit hook that refuses everything yields a failed node with a snapshot quarantine and a receipt; a deleted journal is reported as gaps on the next run and the first run's copy is kept beside the receipts.

### Tools, this run
- umbel: a worker waiting on a subagent looks idle to a pane-based watcher — 25 minutes lost, though D16's timeout and D11's quarantine kept the work and D17 resumed it. → comment on umbel#67 (read the transcript's last event time, not the pane; carry a reason on the idle answer).
- tend2: `tend2 verify --check 7 --dry-run` accepted `--dry-run`, ignored it, and STAMPED the read-only page inside the worker's worktree (the worker restored it with git checkout). A stamped page in a worktree is a tracked change that would ride into the delivery. → comment on tend#185 (ingest's --dry-run is accepted and ignored; verify's writes).
- pleach: the first resume from a quarantine; the receipt history holds the blocked close and the verified one. Two live set-asides (scratch probes) on rs.snapshot. `weeder check --strict` flagged S2 on rs.journal-gap's seam code and the worker fixed it before the gate.

### Issues touched from this loop
- pleach #96, #97, #93 — closed with the merge commit; milestone "Nothing is lost" complete again.

## Tried lines from the workers' handbacks (the last phase's, verbatim)

One line per node is transcribed onto the page, marked as transcribed from the handback pleach kept
beside the receipt. The kept files are the record; these are copies.

#### rs.snapshot (c1)
- (handback, kept by pleach at receipts/rs.snapshot.handback.md) Tried: 2026-09-11 GREEN for c1 — `bun run check` green (718 pass, 0 fail, biome clean) with no further edits; `weeder check --strict` on the diff exits 0 with no results; the evidence test is byte-identical to the RED commit 763ca80. Did not run `tend2 verify` myself (it writes the stamp into the read-only loop page). The next worker (c2) must know: the harness knob is now `branchBusy` (formerly `commitBranchBusy`), quarantine events log as 'snapshot', and a real snapshot refuses a branch another worktree has checked out with "used by worktree" so quarantineTree's .2/.3/.4 fallback still fires.

#### rs.commit-refused (c2)
- (handback, kept by pleach at receipts/rs.commit-refused.handback.md) Tried: 2026-09-11 GREEN for c2 with no code change needed: bun run check exit 0 (723 pass), weeder check --strict exit 0 with no findings, evidence test 5/5. I first wrote the check log to the repo root by mistake and trashed it (scratch goes in .loop-scratch/). I left tend2 verify to the conductor because stamps belong to the verifier. The implement phase's open siblings stand: an emitVerdict throw after a landed commit still journals gate-fail 'commit' with no receipt, and a refusal after `git commit` lands (reference-transaction hook, or node/<id> busy) keeps nothing, which allowEmpty on the quarantine would fix via the snapshot's HEAD parent.

#### rs.journal-gap (c3)
- (handback, kept by pleach at receipts/rs.journal-gap.handback.md) Tried: 2026-09-11 GREEN phase for c3: `bun run check` was already green; weeder --strict flagged one S2 warning (a catch block with no stated reason) on `parseLine` in src/seams/journal.ts, fixed by moving the reason (torn append, hand edit, empty tail after the last newline: not a verdict line) into the catch block; weeder now reports 0 findings and check is green (731 pass). No behaviour change, no test touched. Rejected running `tend2 verify` myself because the page's stamps belong to the conductor.

#### rs.run-copy (c4)
- (handback, kept by pleach at receipts/rs.run-copy.handback.md) Tried: 2026-09-11 GREEN for c4: `bun run check` exit 0 (733 pass / 0 fail), `weeder check --strict` exit 0 with no results, no fixes needed; trashed a stray check log written at the repo root instead of `.loop-scratch/`. Next worker: the known limit stands, since concurrent plans of different sources share one journal, so a run's copy can include the other run's lines in its span (documented in docs/journal.md).

#### rs.blocked-md (c5)
- (handback, kept by pleach at receipts/rs.blocked-md.handback.md) Tried: 2026-09-11 GREEN c5: `bun run check` exits 0 (742 pass / 0 fail) with no changes needed, and `weeder check --strict` returns no findings. The test diff since the red commit only adds cases (phased red-phase BLOCKED.md, empty BLOCKED.md, the real-seam readBlocked integration test); the one removed line is buildPrompts taking a node id instead of hard-coding 'x', with no assertion loosened. Design as implemented: readBlocked reads only the file at the worktree root; BLOCKED.md stays in the quarantine as the evidence and is not added to NEVER_DELIVERY; runWork's wroteBlocked hook ends a phased ladder before that phase's gate. Known gap: a base that already carries BLOCKED.md blocks every node built on it, with the file's text as the reason. The docs node (c6) still owes docs/journal.md and README text for the BLOCKED.md rule.

#### rs.docs (c6)
- (handback, kept by pleach at receipts/rs.docs.handback.md) Tried: 2026-09-11 GREEN for c6: `bun run check` exit 0 (751 pass, 0 fail, biome clean) and `weeder check --strict` exit 0 with no results, so nothing needed fixing; the diff is README.md and docs/journal.md only, the test was committed in the red phase and is unchanged. Rejected: any further edits (the check was already green). Open for a later worker: the `blocked` row still does not mention `--idle-ms`.

#### rs.e2e (c7)
- (handback, kept by pleach at receipts/rs.e2e.handback.md) Tried: 2026-09-11 in the green phase, `bun run check` was already green (760 pass) and weeder --strict reported no findings, so nothing needed fixing. A probe `tend2 verify --check 7 --dry-run` ignored `--dry-run` and stamped c7 [x] on the read-only page; the stamp proves c7 passes, and I restored the page with git checkout. Next worker: do not pass --dry-run to tend2 verify, because it is not honoured and writes the stamp; c5 (test/loop/blocked-md.test.ts) changed in the implement phase and needs a fresh verify.
