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

## Conducting (2026-09-09)

Run: `pleach run docs/dogfood/test-phase-commit/plan.json --repo-root . --max-concurrency 1`, workers
claude-opus-5 through umbel, smoke `weeder check --strict`, audit = tend2 verify on the node's check
as a self-integral audit, run cross-provider by opencode + deepseek/deepseek-v4-pro (codex answered a
bare exec and an umbel probe, then 404'd on gpt-5.5 inside the real auditor session). Three launches:
the first drained at cape-town's order (owner's window at 12%) after tpc.empty settled; the second
aborted by me when the codex auditor wedged; the third ran to the end. Result: 7 of 7 nodes verified
in 9 attempts, landed by `pleach land` (fast-forward, land gate green) onto feat/test-phase-commit at
73dbc57; `bun run check` green (425 tests); every check stamped by `tend2 verify`.

| node | check | attempts | wall | what the extra attempt was |
|---|---|---|---|---|
| tpc.seal | c1 | 1 | 11m10s | — |
| tpc.empty | c3 | 1 | ~8m | — |
| tpc.hygiene | c5 | 2 | 14m28s | the close's secrets gate refused a literal AKIA fixture |
| tpc.retry | c4 | 1 | 8m53s | — |
| tpc.e2e | c2 | 2 | 16m34s | the RED gate refused a test that already passed |
| tpc.validate | c6 | 1 | 4m56s | — |
| tpc.journal-doc | c7 | 1 | 4m11s | — |

The conductor that ran this loop was the pre-D13 pleach (a conductor's own code does not change
mid-run), so the `node/<id>` branches carry one commit each; the first red seals in real history come
from the next loop this code conducts.


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


### Issues filed from this loop (2026-09-08/09; plus #63 and #67 comments from the conducting)

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

### codex, second try (10:00)
- Bare `codex exec` → OK; umbel spawn/send/wait/read probe → OK; the real auditor session → 404 on gpt-5.5 (WebSockets, then HTTPS fallback), idle at its prompt. Probes are not proof for a provider that fails intermittently. Aborted my run to stop the scheduler launching the next node with the same auditor; the finished, staged hygiene build was disposed WITHOUT quarantine or receipt (pleach#67, second occurrence; #61 from the other side). ~10 min of Opus lost. Audits back on opencode/deepseek for the rest.

### tpc.hygiene (verified, 2 attempts, 14m28s, audit pass)
- Attempt 1 was refused by pleach's own close-time secrets battery: the worker wrote a literal AKIA fixture to test the secret detector. The retry carried that evidence verbatim and the worker rewrote the fixture (a constructed string, not an added literal line). The gate and the evidence-carrying retry both did their job; the cost was one extra RED→IMPL→GREEN cycle (~7 min).
- The journal shows attempts: 2 with nothing between node-start and verdict — pleach#63, commented with this case.
- Diff quality: extracted markerEvidence()/scanHygiene() from the close and ran both in the seal; GateKind widened with a template-literal type derived from core/hygiene.ts rather than a duplicated list. Reviewed.

### tpc.retry (verified, 1 attempt, 8m53s, audit pass)
- Resume-at-impl is keyed to the sealed phase's INDEX (tracked per tree in runNode, reset on re-isolation), not a boolean; evidence rides the first phase actually sent; a plan whose phases end on the sealed red raises a typed PlanInvalidError (run-plan maps a node throw to a failed verdict; run-node's finally disposes the tree). Reviewed; sound.

### tpc.e2e (verified, 2 attempts, 16m34s, audit pass) — the real-git proof
- Attempt 1 was refused by the RED gate ("Gate 'red' failed (exit 0)"): the worker's flat-layout e2e test already passed against the seal the earlier nodes built. The retry carried that evidence; looking for a case that honestly fails, the worker put the test in a directory git had never seen — and found a LATENT SEAM BUG: `changedFiles` used `git status --porcelain`, which collapses an untracked directory to `dir/`, so a file inside a new directory was never named individually in the staged set. Consequences beyond the seal: the receipt's stagedFiles miscounted, and SEC4a `auditGateTampering` could not see a script planted in a new directory. Fixed with `--untracked-files=all`, pinned in the seam's integration test. The TDD gate earned its keep: it refused a green-on-arrival test and the search for red found a security-relevant bug.
- The proof asserts, through the real CLI and real git: exactly two commits above the seed; red subject + `pleach-phase: red` trailer; tip's parent is red; red's tree has the spec and the unchanged seed; the test FAILS checked out at red and PASSES at tip; the journal's phase-commit sha is the red commit.

### tpc.validate (verified, 1 attempt, 4m56s, audit pass)
- planWarnings() pure in core; validateReport() pure in the face (stdout JSON gains `warnings: []`, one stderr line per warning, exit stays 0). Reviewed; matches the check.

### tpc.journal-doc (verified, 1 attempt, 4m11s, whole-page audit: 7/7 pass)
- The documentation pin found a second undocumented event (`audit-egress-unparseable`) and the worker documented it. Scans src/ for `event: '…'` literals — a real scan, not a hand-kept list.

## Tried lines from the workers' handbacks (every phase, verbatim)

Each node's worker ended every phase with a dated `Tried:` line as its work order required. One line
per node — the implementation phase's, which carries the decisions — is transcribed onto the page
(after the loop landed: a page edit mid-loop moves tend2's payload pin, jahala/tend#159, and the
recorded acceptance with it). The RED and GREEN phase lines are kept here. Recovered from Claude
Code's own transcripts, since neither pleach nor umbel keeps the handback (jahala/pleach#66).

#### tpc.seal (c1)
- (RED) Tried: 2026-09-09 wrote the RED loop test for D13 c1 (test/loop/phase-commit.test.ts, 3 tests, 2 failing on the absent seal; tsc + biome clean, rest of check green). Asserted through runPlan on the in-memory seams: red-gate exec → scoped stage of the red files → detached `commit` → impl send → settle `commitBranch`, plus message subject/body/`pleach-phase: red` trailer, the `phase-commit` journal record, and that no ref points at the red sha. Rejected asserting git parentage of the settle commit on the red one — the in-memory git models no parents and adding an unpopulated parent map would be a stub; the honest in-memory maximum is "one isolation, seal first, no branch moved in between", with real history left to the e2e sibling (c2). Next worker: the file header names the harness surface the impl must provide — `IsolateSeam.commit(cwd, message)` logged as EventLog kind `'commit'` and `InMemoryGit.commitMessages` keyed by the returned sha; the seal's marker/hygiene gating, empty-red and retry semantics are deliberately untouched (sibling checks).
- (IMPL) Tried: 2026-09-09 implemented D13 c1 — new `IsolateSeam.commit(cwd, message)` (real seam + in-memory harness + a real-git integration test alongside commitBranch's), `RunWorkOpts.sealRed` called at RED-pass before the next prompt, and `sealRedPhase` in run-node doing the scoped stage → detached commit → `phase-commit` journal; full `bun run check` green. Left the receipt gate ladder untouched as the How allowed: recording `{gate:'red',exitCode:0}` while the green gate records nothing would misstate the ladder, and the red/green gates live in runWork which does not own run-node's `gates` array — a sibling should add both or neither. Fixed a latent harness bug: `newSha()` returned one identical sha for every commit in a run (padding swallowed by `slice(0,40)`); shas are now distinct 40-hex strings, so any sibling test comparing two commits gets real values. Corrected one literal in the RED test (`/wt/n1/0` → `/wt/n1/\d+`) because the harness numbers worktree cwds from 1 — the staged-file assertion is unchanged and still exact. Next worker: an empty red phase currently reaches the seam and `git commit` fails with `IsolateCatastrophicError`, which runPlan degrades to a failed verdict — the empty-red sibling must gate before the seal; likewise a retry in a sealed tree still re-enters at red (the red gate then exits 0 and fails as before, so no second seal happens today, but the resume-at-impl sibling owns that path), and `docs/journal.md` still lacks `phase-commit`.
- (GREEN) Tried: 2026-09-09 GREEN pass — ran `bun run check` (exit 0: tsc, biome over src+test, 386 pass / 0 fail) plus the five directly affected suites; nothing needed fixing, so no code changed in this phase and I rejected touching anything further as scope creep. Standing notes for siblings, unchanged from the impl phase: the receipt gate ladder is deliberately untouched (recording `{gate:'red',exitCode:0}` without a matching green record would misstate the ladder, and both gates live in runWork which does not own run-node's `gates`); an empty red phase reaches the seam today and `git commit` fails as `IsolateCatastrophicError`, which runPlan degrades to a failed verdict, so the empty-red sibling must gate before the seal; a retry still re-enters at red (the red gate then exits 0 and fails first, so no second seal happens today) for the resume-at-impl sibling; `docs/journal.md` still lacks `phase-commit`; and `InMemoryGit.newSha()` now returns distinct 40-hex shas after a latent padding bug made every commit in a run share one string.

#### tpc.empty (c3)
- (RED) Tried: 2026-09-09 wrote the RED test for c3 (empty red phase) at test/loop/phase-commit-empty.test.ts against the in-memory harness; asserted the no-seal/no-stage/no-ref/no-impl-prompt set plus same-tree retry with evidence in the re-prompt and in the journal's verdict.gate.outputTail. Rejected pinning the evidence wording (answer key) in favour of two content regexes, and rejected asserting a specific gate exitCode since the claim doesn't fix one — only that it is non-zero. Added a passing guard test proving the emptiness check must read the union (filesTouched ∪ changedFiles), not the worker's self-report, since that is the fix most likely to be written wrong. Next worker: the throw belongs in run-work.ts's `red` branch after the exit-code check and before `opts.sealRed`, but the file set lives in run-node's `sealRedPhase` — deciding where the union is computed is the one design call left open.
- (IMPL) Tried: 2026-09-09 implemented c3 — `sealRedPhase` (run-node.ts) throws `GateFailedError('red', EMPTY_RED_EVIDENCE, exitCode)` when `filesTouched ∪ changedFiles` is empty, before staging or committing; the red gate's exit code now travels through the `sealRed` callback in run-work.ts so the refusal reads like any other red failure. Rejected computing the union inside run-work (would require handing the loop's phase driver the isolate seam it deliberately lacks — sending one number down beats sending a seam up), and rejected making `sealRed` required (unrelated churn in run-work.test.ts; run-node is the only production caller). The evidence names the harness-fault reading — missing runner, wrong path, command not found — because a real red and a broken harness are indistinguishable from the exit code alone. Full `bun run check` green including test/e2e/phase-commit.test.ts.
- (GREEN) Tried: 2026-09-09 GREEN phase — ran `bun run check` (exit 0: tsc, biome over src+test including the new file, 389 pass/0 fail) and `weeder check --strict` (exit 0, no results); no fixes were needed, so nothing was changed in this phase beyond verification. Confirmed the D13 loop tests pass together (6/6), meaning the empty-phase refusal did not disturb the seal tpc.seal landed. Next worker: `test/e2e/phase-commit.test.ts`, named in ledger D13, still does not exist — the real-git parentage proof (base → red → verified) is unclaimed by any check I touched.

#### tpc.hygiene (c5)
- (RED, attempt 1) Tried: 2026-09-09 wrote test/loop/phase-commit-hygiene.test.ts RED for c5 — four cases (markers → gate `marker`, secret → gate `hygiene:secret`, secret retry in the same tree, clean red still seals), each asserting no detached `commit` and no impl prompt, so the seal must fail *before* committing rather than being caught later by the close. Rejected asserting `git.refs.size === 0` (a failed node legitimately quarantines to `quarantine/<id>`) and asserting `stage` counts (the close scans markers before staging but hygiene needs the staged diff, so staging order is the implementer's call). Pinned `exitCode: -1` on both gates to match the close's records byte-for-byte; the GREEN phase must widen `GateKind` in core/errors.ts to admit `hygiene:<kind>`.
- (IMPL, attempt 1) Tried: 2026-09-09 implemented c5 — extracted `markerEvidence`/`scanHygiene` from the close in run-node.ts and ran both from `sealRedPhase` before its commit (markers before staging, hygiene over the staged red set), widening `GateKind` with a template-literal `hygiene:${HygieneFailure['kind']}` so errors.ts derives the labels from core/hygiene.ts instead of duplicating them. Rejected duplicating the close's ladder into the seal (two gates would drift apart — the whole point of the check) and rejected pushing seal-time GateRecords into the receipt's `gates[]` (the seal fails inside runWork, where red/green gate failures already record none; changing that is a receipt-shape decision outside this check). Next worker: the close's inline `-1`s were deliberately left alone for a byte-identical diff — the new `SCAN_EXIT` constant only serves the seal.
- (GREEN, attempt 1 (refused at close: secrets)) Tried: 2026-09-09 GREEN phase — ran `bun run check` (typecheck + biome + 404 tests) and it was already 0-red from the implement phase, so nothing needed fixing; re-ran biome on the three touched files and `weeder check --strict` (exit 0, no findings) to confirm before stopping. Rejected making any further edit for its own sake — the check is proven by the four cases in test/loop/phase-commit-hygiene.test.ts and the close's suites stay green, so touching the ladder again would only risk the byte-identical close records. Next worker: c4 (test/loop/phase-commit-retry.test.ts, resume-at-impl after a sealed red) is still unwritten and nothing here touches seal-resume state.
- (RED, attempt 2) Tried: 2026-09-09 wrote the c5 RED at test/loop/phase-commit-hygiene.test.ts — marker, secret (settle + retry), bulk-deletion and clean-red legs, asserting no 'commit' event, no 'phase-commit' journal entry, no impl prompt, and the close's own gate labels/evidence; confirmed 4 fail / 1 pass with the rest of the suite green and tsc + biome clean. Rejected a literal AKIA fixture — it is an added line the repo's own hygiene battery flags (that is what failed the previous attempt), so the AWS example key is assembled at runtime from two halves and I verified the staged diff scans clean through checkDiffHygiene itself. Added the deletion leg deliberately: it forces the impl to reuse the whole checkDiffHygiene battery rather than a bespoke secret regex. Reverted the previous attempt's implementation (src/loop/run-node.ts, src/core/errors.ts) back to HEAD so the phase is genuinely red — the patch is preserved at .loop-scratch/prev-attempt-impl.patch.
- (IMPL, attempt 2) Tried: 2026-09-09 implemented c5 — extracted the close's two deterministic scans into markerEvidence()/scanHygiene() in run-node.ts and called them from the seal before it commits (empty-check → scanMarkers → stage → checkDiffHygiene → commit), throwing GateFailedError('marker'|'hygiene:<kind>', evidence, -1) through the existing handleGate path; widened GateKind in core/errors.ts with a template-literal member derived from HygieneFailure['kind'] so the gate vocabulary is single-sourced. Rejected duplicating the scan bodies into sealRedPhase (two copies of the evidence string would drift) and rejected a loose `hygiene:${string}` widening (it would let a typo'd kind through the type). bun run check green: 394 pass / 11 skip / 0 fail, tsc + biome clean. Known consistency point, not a defect: the seal's scans push no GateRecord into the receipt's gates[] because runWork has no handle on that array — the red/green phase gates already behave the same way. .loop-scratch/selfscan.ts scans your own staged diff with the real battery; run it before handing back, since a literal credential fixture in a test is an added line this repo's own gate reads as a leak.
- (GREEN, attempt 2) Tried: 2026-09-09 GREEN phase — ran bun run check (exit 0: tsc + biome clean, 394 pass / 11 skip / 0 fail) and weeder check --strict (exit 0, results empty) with nothing to fix; re-confirmed the target test at 5 pass / 0 fail against the 4 fail it showed pre-impl, so the pass is behavioural. Diff is the three intended files only; scratch stayed in gitignored .loop-scratch/. No formatting fixes were needed on the new test file, so I rejected running biome --write over it — the repo's biome.json includes ** and a stray write near docs/tend or docs/tend2 rewrites the polyglots. Known consistency point for the next worker, not a defect: the seal's scans push no GateRecord into the receipt's gates[], because runWork holds no handle on that array — the red/green phase gates already behave the same way.

#### tpc.retry (c4)
- (RED) Tried: 2026-09-09 wrote the RED test test/loop/phase-commit-retry.test.ts — four cases through runPlan on the in-memory harness (post-seal green failure resumes at impl with evidence; a mid-list red proves "skip up to and including red"; a red-gate failure restarts at red; dead+resume re-seals on the fresh tree with a distinct sha in a distinct cwd). Confirmed the two resume cases fail because attempt 2 re-sends the red prompt and the re-run red gate then passes (node quarantines), not from a typo. Rejected asserting on a new runWork option or a `resumeFromImpl` flag directly — the claim is behavioural and pinning the API would hand the implementer an answer key; also rejected keying the exec script by call-count alone in the dead+resume case (it must be per-cwd, or the fresh tree's red gate would read the old tree's counter and mask a per-node seal flag passing wrongly). Next worker: the flag must be per-tree (cleared where `iso = null` in the dead branch of run-node.ts:234), and the evidence must ride the first phase actually sent, not phase index 0.
- (IMPL) Tried: 2026-09-09 implemented the resume — run-node tracks `redSealedAt` (the sealed phase index) per tree, cleared where the tree is isolated so dead+resume re-seals, and run-work enters the ladder at `redSealedAt + 1` with the evidence on the first phase it sends. Rejected a boolean `redSealed` + "skip to after the last red phase" (a legal multi-red list would drop a later red that never ran — the index costs the same and is correct), and rejected letting a red-terminal list fall through to `return last as WorkerResult` with `last === null` (it crashed downstream as a TypeError; it now throws PlanInvalidError, which run-plan maps to a failed verdict, pinned by a fifth test). Next worker: `redSealedAt` is snapshotted into the runWork opts at call time while the seal callback mutates the outer binding — that ordering is what makes the flag mean "at attempt start"; don't turn it into a getter.
- (GREEN) Tried: 2026-09-09 GREEN phase — ran `bun run check`, exit 0 with 399 pass / 0 fail and biome clean; nothing was red, so no fixes were needed and I made no further edits (deliberately: touching passing code to look busy is how a green gets faked). Re-ran the whole D13 test family together to confirm the resume did not disturb the seal, empty-red, or hygiene siblings, and re-read the diff for weeder's criteria — no deleted/skipped tests, no weakened assertions, no stubs or TODOs, no stray files, `.loop-scratch/` empty. Next worker: the only behaviour change outside the resume is that a phase list with nothing left to run now throws PlanInvalidError (run-plan maps it to a failed verdict) where it previously returned null and crashed downstream — test 5 in phase-commit-retry.test.ts pins it.

#### tpc.e2e (c2)
- (RED, attempt 1 (refused: already green)) Tried: 2026-09-09 wrote test/e2e/phase-commit.test.ts as the real-CLI/real-git proof of base → red → verified (two commits above seed, git-parsed `pleach-phase` trailer, red tree = test + untouched seed, both trees checked out and the test command actually run in them, tip parent = red, receipt trailer, one phase-commit journal event with the red sha); it passes on first run because the seal landed with tpc.seal (eda6831), so no honest RED exists — verified the test discriminates by short-circuiting `sealRed` (fails at `above.length` 1 ≠ 2) and restored the source byte-for-byte. Rejected weakening the seal to manufacture red, and rejected a substring check for the trailer in favour of git's own parser (weeder reads it as a trailer). Probed two real-seam paths the loop tests can't reach — retry after a sealed red through the real CLI (one seal, tree reused) and trailer parsing via `git interpret-trailers` — both agree with the loop tests, so the seam needs no fix; BLOCKED.md at repo root records the whole finding. Next worker: this node needs its red phase skipped, not a new implementation.
- (RED, attempt 2) Tried: 2026-09-09 wrote test/e2e/phase-commit.test.ts as a two-layout proof (flat + test-in-a-new-directory) driven by real CLI/real git and new NESTED-* scenarios in test/fixtures/phases-scripted.config.ts; flat passes, nested fails because `changedFiles` uses `git status --porcelain` and collapses untracked directories, so the seal journals `test/` instead of `test/calc.test.ts` — same list feeds the receipt's staged-file count and SEC4a `auditGateTampering`, so a script created in a new directory evades tamper detection; rejected the previous attempt's BLOCKED verdict (the seal is correct, but the check's own instruction to fix a real-seam disagreement had a real one to find) and rejected breaking the impl to manufacture red; fix for impl is `git status --porcelain --untracked-files=all` in src/seams/isolate.ts plus the isolate-seam tests that pin the collapsed form.
- (IMPL) Tried: 2026-09-09 fixed the root cause the RED test found — `changedFiles` now uses `git status --porcelain --untracked-files=all` so a file in a directory git has never seen is named individually instead of collapsing to `dir/`; that list is the staged set, so the collapse was also mis-counting the receipt's stagedFiles and blinding SEC4a `auditGateTampering` to a script created in a new directory; pinned the case in the seam's own integration test (test/integration/isolate.test.ts) rather than only through the e2e; rejected post-processing the collapsed output in `changedFiles` (re-implementing what `-uall` already does) and rejected widening to `-z` quoted-path handling (real but pre-existing, unexercised, belongs to the S1 staging item — next worker should know it is still open); `bun run check` green at 401 pass / 11 skip / 0 fail.
- (GREEN) Tried: 2026-09-09 green phase — `bun run check` exits 0 at 401 pass / 11 skip / 0 fail with tsc and biome clean, and `weeder check --strict` exits 0 on the diff (its lone T5 warning is proximity only: the fixture is +30/−0 additive and the e2e assertion that drove the fix predates it and was never edited); added `rm` of the probe worktree's mkdtemp parent in `testAt` so runs leave no /tmp litter, and rejected touching any assertion in the green phase; next worker should know the `-z` quoted-path defect in porcelain parsing is still open under the S1 staging item, not D13.

#### tpc.validate (c6)
- (RED) Tried: 2026-09-09 wrote the RED test for c6 at test/unit/validate-phases.test.ts — planWarnings(plan) in core (last-phase-is-impl, plan order, unphased never warns) plus a pure validateReport(plan) → {code, stdout, stderr} in faces/cli.ts so the JSON warnings[], the one-line-per-warning stderr and exit 0 are all unit-testable; rejected monkey-patching process.stdout.write in test/unit (pure-only by doctrine; summaryExitCode is the precedent for a pure exported face helper), and rejected asserting a byte-exact warning string in favour of pinning the node id + "phases end on impl" + "green gate". Next worker: implement both surfaces and make verbValidate a two-write edge; the existing-keys assertion locks {valid, order, waves, nodes} so the addition must stay additive.
- (IMPL) Tried: 2026-09-09 implemented c6 — `planWarnings(plan)` in src/core/validate.ts (last-phase-is-impl, plan order) plus a pure `validateReport(plan) → {code, stdout, stderr}` in src/faces/cli.ts, with `verbValidate` reduced to writes; `bun run check` green (391 pass) and the real `pleach validate` verified on an impl-terminal plan (exit 0, warnings[] in JSON, one `pleach: warning: …` stderr line). Rejected warning on an empty `phases` array (a different defect from the one the claim names) and rejected folding warnings into `validatePlan`'s return (it throws on invalid plans; a sibling pure function keeps advice separate from validity, and every existing validate test stayed untouched). Next worker: the JSON key order is `{valid, order, waves, nodes, warnings}` and warnings is always present — the e2e `validate` assertions in test/e2e/cli.test.ts do not pin stderr emptiness, so a phased example plan added later will surface a warning line there.
- (GREEN) Tried: 2026-09-09 GREEN phase — ran `bun run check` (typecheck + biome + 402 tests) and `weeder check --strict`, both exit 0 with no findings, so no fixes were needed; rejected touching the HELP/README validate line (it still reads true and growing it for a flag-free addition is churn) and rejected adding a separate `// ledger: D13` line comment since the test's docblock already carries the id for the grep convention. Next worker: `validateReport` is the pure surface to extend if `pleach validate` ever needs more advice — add to `planWarnings` in core and the stderr lines follow automatically.

#### tpc.journal-doc (c7)
- (RED) Tried: 2026-09-09 wrote the RED unit test test/unit/journal-doc.test.ts pinning docs/journal.md's events table against a real regex scan of every `event: '<name>'` literal under src/ (both directions, plus a non-vacuity guard on both set sizes and a specific phase-commit fields assertion); it fails for the right reason — `phase-commit` AND the pre-existing undocumented `audit-egress-unparseable` (src/loop/run-node.ts:511) are appended but absent from the table, so GREEN must document both rows, not just D13's. Rejected narrowing the scan to `deps.journal.append({...})` call sites (multiline, and the brittleness would be in the test rather than the promise) and hand-listing event names (the exact drift this check exists to catch); reverse direction (documented-but-never-appended) is already clean at 31 documented / 33 appended.
- (IMPL) Tried: 2026-09-09 made c7 green by documenting two events in docs/journal.md's events table — `phase-commit` (node, phase (red), sha, files; D13, placed after `gate-flaky` where the seal fires) and `audit-egress-unparseable` (node, reaudit, egress), a pre-existing gap the test's source scan caught: run-node.ts:511 has been appending it and quarantine-busy.test.ts already reads it, so the stability promise covered an event no consumer could find. Rejected documenting only `phase-commit` and narrowing the test's scan to exclude the second event (that would be an answer key against the class the check names) and rejected touching the source (the doc was the side that was wrong). As the sink I ran all 7 evidence files on the page: 31 pass, 0 fail, 0 skip; full `bun run check` green at 414 pass.
- (GREEN) Tried: 2026-09-09 GREEN confirmed — `bun run check` exits 0 (414 pass, 0 fail, biome and tsc clean); mutation-probed the pin both ways (removing the `phase-commit` row → 2 fail, adding a phantom documented event → 1 fail) so the green is not vacuous, then restored docs/journal.md to exactly the 2 intended insertions and removed .loop-scratch with `trash`. Kept the second row, `audit-egress-unparseable` — a pre-existing doc gap the source scan exposed (appended at src/loop/run-node.ts:511, already read by test/loop/quarantine-busy.test.ts); rejected narrowing the test's scan to let it stay undocumented, since that would be an answer key against the class the check names. As the sink I re-ran all 7 evidence files on the page: 31 pass, 0 fail, 0 skip.
