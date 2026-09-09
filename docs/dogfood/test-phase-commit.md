# Dogfood — test-phase-commit (D13, jahala/pleach#62)

What the pleach agent hit in tend2, pleach, umbel, weeder and pollen while shaping and conducting
this loop. One entry per observation: tool, severity, what happened, what was expected, what was
done. Findings from the shaping pass apply to all three loops of the 2026-09-08 order and are
recorded here once; the sibling files (`gate-artifacts.md`, `journal-envelope.md`) carry only what
their own runs added.

## Shaping (2026-09-08, before any worker ran)

### pollen

1. **Watcher rings one knock hundreds of times, and re-announces every read message forever** ·
   moderate · `pollen.mjs --watch pleach` printed "cape-town is knocking" ~300 times for one held
   peer, then rang all ten historical messages on every tick. Root cause (from the journal on disk):
   two processes append to one journal with independent `seq` counters (the receiver's `delivered`
   series and the gate's `pending` series interleave; three lines duplicated outright), so "entry N
   is line N" fails, the watcher's resync resets to 0 each tick and replays. → jahala/pollen#19
   (with the root cause as a comment). Workaround: `tail -F` the journal file.
2. **The gate is invisible from the MCP side** · moderate · startup said "5 knocks waiting" without
   names; `pollen_inbox` said "No new messages" while five messages were held. Only the watcher's
   stderr named the peer. → jahala/pollen#19.
3. **A byte-identical message arrived twice**; lines carry no message id and no sent-at, so the
   receiver can neither dedupe nor order them. → jahala/pollen#19.
4. **`--watch <id>` still needs `POLLEN_ID` in the environment**; the server's instruction string
   omits that. `POLLEN_ALLOW` is a list only — "allow anyone who knocks" (the owner's rule for the
   night) has no expression. → jahala/pollen#19.

### tend / tend2

5. **The v1 `tend` MCP entry pointed at a deleted file** (`…/missoula/dist/bin/tend.js serve`) →
   every `tend_*` tool was CONNECTION_CLOSED for the session. Repointed `.mcp.json` to `tend2 mcp`
   (machine-local, gitignored); CLAUDE.md now says so. Nothing in the repo notices a dead MCP binary.
6. **pleach's own CLAUDE.md still described tend v1** (bash-polyglot reads, `tend_get_unblocked`) —
   a worker in a conducted worktree reads that file. Rewritten for tend2 in this branch.
7. **emit-plan emits one node per loop** (known: jahala/tend#158) and **its verify command defaults
   to `<cwd>/dist/cli.js`** (known: jahala/tend#157). Worked around: `--verify-bin
   /opt/homebrew/bin/tend2` and the hand-split generator `docs/dogfood/make-plan.ts`.
8. **emit-plan cannot emit a phased `{test, phases}` node** — the test-first mandate is a sentence in
   the prompt, so the separate red-phase commit this loop builds never triggers on an emitted plan.
   → jahala/tend#163.
9. **emit-plan without `--runner` emits a verify gate that cannot pass** on `.test.ts` evidence (the
   default runner executes the file directly). → jahala/tend#160 (filed by cape-town from this
   report). `--runner "bun test {evidence}"` is required.
10. **The payload pin treats a `## Tried` line as payload**: a worker appending the Tried line the
    garden law requires trips `--expect-payload` ("payload drift, SNAG-13"). → jahala/tend#159 (filed
    by cape-town). Interim: every node's handback ends with a `Tried:` line the conductor transcribes,
    marked as transcribed.
11. **`verify --check 1 --check 2` silently keeps only the last flag.** → jahala/tend#164.
12. **`tend2 <verb> --help` prints the global usage**, not the verb's flags. → jahala/tend#165.
13. **emit-plan on this garden yields 29 preflight warnings**: 25× `missing-evidence-path` for checks
    whose evidence sits inside a parenthesis ("(inferred from test/…)") after the v1 migration, 4×
    `unwired-modules`. It says those checks "can never be verified" while `tend2 next` reports 48
    fresh stamps; and it emitted 3 nodes for 19 loops without saying why 16 were skipped. Not filed:
    the garden's own migration debt, to be cleaned when those loops are next touched.
14. **The work order promises `.loop-scratch/` is "never collected"**, but under pleach the
    conductor collects (stages every untracked-unignored path) and knows no such convention.
    Interim: `.loop-scratch/` ignored in this repo; the gate-artifacts loop makes pleach refuse it
    as delivery by rule.
15. **A `verify` run with a fresh stamp reports `skipped-fresh` and still emits a `pass` verdict in
    the audit egress** — honest given content-keyed stamps, but a conductor's audit that never
    re-ran the evidence reads the same as one that did. Worth a distinct verdict word.

### umbel

16. **`umbel spawn --help` prints the global usage.** → jahala/umbel#66.

### pleach

17. **`biome.json` included both gardens** — a bare `biome check --write .` (some earlier session)
    rewrote all nineteen v1 polyglots and tend2's renderer; 22 uncommitted files on arrival, left
    untouched (not this session's work). Fixed in this branch: the gardens are excluded.
18. **D12 (teardown, PR #58) was cited by code and docs/journal.md but never written into
    docs/ledger.md.** Added from the commit's own account.
19. **Retrying a phased node on the same tree was already broken**: once impl exists in the tree the
    RED gate ("must fail") cannot pass again, so every retry of a `{test, phases}` node after a green
    or smoke failure burned an attempt. Found while designing the seal; the loop's retry check
    (resume at impl once sealed) closes it.
20. **The exec seam interleaves stdout and stderr into one `output`** — a gate whose stdout is a
    document (SARIF) cannot be recovered from it. Becomes the first check of gate-artifacts.

### umbrella (jahala/plotplot)

21. **pleach's fit loop cites `scripts/fit/pleach.sh`, which does not exist** at a107c14 — cape-town
    confirms the per-bed fit scripts are the umbrella's next conducted work; the fit checks stay open
    honestly.
22. **The profile pinned one kind for pleach** (`gate.retry`) and forbids private kinds; ~35 events
    needed a home. Resolved by PR jahala/plotplot#19 (merged): `run.lifecycle`, `node.lifecycle`,
    `gate.result`, and the `plotplot.runner` attribute.

### weeder

23. `weeder check --strict` on the (docs-only) dirty tree: exit 0, SARIF 2.1.0 on stdout, zero
    results, nothing on stderr — the smoke gate this order mandates behaves as a gate should. No
    findings against weeder from shaping; the run will tell.

## Conducting (2026-09-09, resumed on cape-town's word; halted at 12% of the owner's window)

Run: `pleach run docs/dogfood/test-phase-commit/plan.json --repo-root . --max-concurrency 1`, workers
claude-opus-5 through umbel, audits opencode + deepseek/deepseek-v4-pro (codex 404s on this machine
tonight), smoke `weeder check --strict`. Result before the hold: tpc.seal and tpc.empty VERIFIED
(one attempt each, every gate green, audit pass); tpc.hygiene torn down by the drain (see below);
four nodes not yet run. Resume is the same command; the ledger skips the verified nodes.


### tpc.seal (verified, 1 attempt, 11m10s, audit pass via opencode/deepseek-v4-pro)
- pleach discards the builder's handback: WorkerResult.finalMessage is read for audit egress only; a verified builder's final message is never journaled or kept beside the receipt. umbel's kill then removes the whole session dir (~/.umbel/sessions/<name>, events included), so `umbel read` says "Session not found" seconds after the close. The Tried line the garden law requires on every handback therefore survives NOWHERE pleach or umbel own. Recovered from Claude Code's own transcript at ~/.claude/projects/<encoded worktree path>/*.jsonl — provider-specific, and gone with the worktree path's next reuse. → pleach issue (keep the handback beside the receipt, like #59's artifacts); umbel#65 already asks to keep state after kill.
- receipt.facts.stagedFiles = 11 while the diff has 7 files: the staged set is filesTouched ∪ changedFiles and umbel's manifest counts files the worker touched without changing. Harmless for the commit (git add of an unchanged file is a no-op), but the sealed number overstates the delivery.
- Worker quality: found and fixed a latent harness bug (InMemoryGit.newSha() returned one sha for every commit); left three sibling-scoped notes in Tried. Each phase ended with a dated Tried line as instructed.
- umbel: `umbel ls` LAST column stays "—" for a live claude session that is clearly active; the pane-hash watch was the only idle signal available.

### tpc.empty (verified, 1 attempt, ~8m, audit pass)
- Clean: the refusal is a GateFailedError('red', …) with a harness-fault evidence text; the exit code travels down the sealRed callback rather than a seam travelling up. Reviewed against the diff.

### the hold (cape-town: owner's window at 12%)
- pleach has no "finish the current node, then stop" — the scheduler launches the next ready node in the same tick as the close. I armed a SIGINT on tpc.empty's `verdict`; tpc.hygiene was still isolated, provisioned and spawned in the seconds before the signal took effect, then torn down. Cost: one spawn+kill. Wanted: `pleach run --until <node>` / `--nodes N` / a pause file, so an operator can drain without racing the scheduler.
- The in-flight node killed by the teardown settled as `verdict: failed` with `worker seam error: wait exited 137` ("failed after 0 attempt(s)"), and NO receipt was written for it. The contract has `status: 'aborted'` exactly for this, and D11 promises a receipt on every terminal settle. Two gaps in the D12 path. → pleach issue.
- After the abort: no orphaned worktree, no stale lock, `run-end` written, exit 1 (2 closed · 1 failed · 4 skipped). Resume = re-run the same command; verified nodes are skipped by the ledger.
- Tried transcription must wait for the whole loop: adding a Tried line moves the page's payload, the plan's `--expect-payload` goes stale, and the closed nodes' recorded acceptance no longer matches the plan → they would re-dispatch under acceptance evolution. tend#159 (pin the checks section) resolves it.


### Issues filed from this loop (2026-09-08/09)

- pleach: #62 (the loop), #66 (handback kept nowhere), #67 (teardown-killed node settles failed, no
  receipt), #72 (umbel adapter passes no --idle-timeout), #73 (stagedFiles overstates).
- tend: #163 (no phased node from emit-plan), #164 (repeated --check), #165 (verb --help), #176
  (skipped-fresh relays a pass), #177 (preflight contradicts next; skipped loops unnamed), #178
  (the .loop-scratch/ promise nobody honours under a conductor); comment on #174 (no repo-wide
  preamble in the work order). cape-town filed #159 and #160 from this report.
- umbel: #66 (spawn --help), #71 (ls LAST empty for an active session); comment on #65 (kill
  deletes the session dir → the handback is lost).
- pollen: #19 (watcher replay, root cause; invisible gate; no message id/time).
- umbrella: jahala/plotplot#19 (merged): the three pleach kinds + plotplot.runner.

## Tried lines from the workers' handbacks (transcribed; to move onto the page when the loop lands)

Each node's worker ended every phase with a dated `Tried:` line as its work order required. They
are held here rather than on the page because a page edit moves tend2's payload pin (jahala/tend#159)
and the plan's recorded acceptance with it, which would re-dispatch the verified nodes on resume.
Recovered from Claude Code's own transcripts, since neither pleach nor umbel keeps the handback
(jahala/pleach#66).

#### tpc.seal (c1)
- (RED) Tried: 2026-09-09 wrote the RED loop test for D13 c1 (test/loop/phase-commit.test.ts, 3 tests, 2 failing on the absent seal; tsc + biome clean, rest of check green). Asserted through runPlan on the in-memory seams: red-gate exec → scoped stage of the red files → detached `commit` → impl send → settle `commitBranch`, plus message subject/body/`pleach-phase: red` trailer, the `phase-commit` journal record, and that no ref points at the red sha. Rejected asserting git parentage of the settle commit on the red one — the in-memory git models no parents and adding an unpopulated parent map would be a stub; the honest in-memory maximum is "one isolation, seal first, no branch moved in between", with real history left to the e2e sibling (c2). Next worker: the file header names the harness surface the impl must provide — `IsolateSeam.commit(cwd, message)` logged as EventLog kind `'commit'` and `InMemoryGit.commitMessages` keyed by the returned sha; the seal's marker/hygiene gating, empty-red and retry semantics are deliberately untouched (sibling checks).
- (IMPL) Tried: 2026-09-09 implemented D13 c1 — new `IsolateSeam.commit(cwd, message)` (real seam + in-memory harness + a real-git integration test alongside commitBranch's), `RunWorkOpts.sealRed` called at RED-pass before the next prompt, and `sealRedPhase` in run-node doing the scoped stage → detached commit → `phase-commit` journal; full `bun run check` green. Left the receipt gate ladder untouched as the How allowed: recording `{gate:'red',exitCode:0}` while the green gate records nothing would misstate the ladder, and the red/green gates live in runWork which does not own run-node's `gates` array — a sibling should add both or neither. Fixed a latent harness bug: `newSha()` returned one identical sha for every commit in a run (padding swallowed by `slice(0,40)`); shas are now distinct 40-hex strings, so any sibling test comparing two commits gets real values. Corrected one literal in the RED test (`/wt/n1/0` → `/wt/n1/\d+`) because the harness numbers worktree cwds from 1 — the staged-file assertion is unchanged and still exact. Next worker: an empty red phase currently reaches the seam and `git commit` fails with `IsolateCatastrophicError`, which runPlan degrades to a failed verdict — the empty-red sibling must gate before the seal; likewise a retry in a sealed tree still re-enters at red (the red gate then exits 0 and fails as before, so no second seal happens today, but the resume-at-impl sibling owns that path), and `docs/journal.md` still lacks `phase-commit`.
- (GREEN) Tried: 2026-09-09 GREEN pass — ran `bun run check` (exit 0: tsc, biome over src+test, 386 pass / 0 fail) plus the five directly affected suites; nothing needed fixing, so no code changed in this phase and I rejected touching anything further as scope creep. Standing notes for siblings, unchanged from the impl phase: the receipt gate ladder is deliberately untouched (recording `{gate:'red',exitCode:0}` without a matching green record would misstate the ladder, and both gates live in runWork which does not own run-node's `gates`); an empty red phase reaches the seam today and `git commit` fails as `IsolateCatastrophicError`, which runPlan degrades to a failed verdict, so the empty-red sibling must gate before the seal; a retry still re-enters at red (the red gate then exits 0 and fails first, so no second seal happens today) for the resume-at-impl sibling; `docs/journal.md` still lacks `phase-commit`; and `InMemoryGit.newSha()` now returns distinct 40-hex shas after a latent padding bug made every commit in a run share one string.

#### tpc.empty (c3)
- (RED) Tried: 2026-09-09 wrote the RED test for c3 (empty red phase) at test/loop/phase-commit-empty.test.ts against the in-memory harness; asserted the no-seal/no-stage/no-ref/no-impl-prompt set plus same-tree retry with evidence in the re-prompt and in the journal's verdict.gate.outputTail. Rejected pinning the evidence wording (answer key) in favour of two content regexes, and rejected asserting a specific gate exitCode since the claim doesn't fix one — only that it is non-zero. Added a passing guard test proving the emptiness check must read the union (filesTouched ∪ changedFiles), not the worker's self-report, since that is the fix most likely to be written wrong. Next worker: the throw belongs in run-work.ts's `red` branch after the exit-code check and before `opts.sealRed`, but the file set lives in run-node's `sealRedPhase` — deciding where the union is computed is the one design call left open.
- (IMPL) Tried: 2026-09-09 implemented c3 — `sealRedPhase` (run-node.ts) throws `GateFailedError('red', EMPTY_RED_EVIDENCE, exitCode)` when `filesTouched ∪ changedFiles` is empty, before staging or committing; the red gate's exit code now travels through the `sealRed` callback in run-work.ts so the refusal reads like any other red failure. Rejected computing the union inside run-work (would require handing the loop's phase driver the isolate seam it deliberately lacks — sending one number down beats sending a seam up), and rejected making `sealRed` required (unrelated churn in run-work.test.ts; run-node is the only production caller). The evidence names the harness-fault reading — missing runner, wrong path, command not found — because a real red and a broken harness are indistinguishable from the exit code alone. Full `bun run check` green including test/e2e/phase-commit.test.ts.
- (GREEN) Tried: 2026-09-09 GREEN phase — ran `bun run check` (exit 0: tsc, biome over src+test including the new file, 389 pass/0 fail) and `weeder check --strict` (exit 0, no results); no fixes were needed, so nothing was changed in this phase beyond verification. Confirmed the D13 loop tests pass together (6/6), meaning the empty-phase refusal did not disturb the seal tpc.seal landed. Next worker: `test/e2e/phase-commit.test.ts`, named in ledger D13, still does not exist — the real-git parentage proof (base → red → verified) is unclaimed by any check I touched.
