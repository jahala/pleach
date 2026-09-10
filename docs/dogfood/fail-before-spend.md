# Dogfood — fail-before-spend (D19, jahala/pleach#64 #69 #75 #68 #73 #81)

What the pleach agent hit in tend2, pleach, umbel, weeder and pollen while conducting this loop.
The shaping-pass findings that apply to every loop of the 2026-09-08 order are recorded once in
`test-phase-commit.md`; this file carries what this loop's run added.

## Conducting (2026-09-12)

Run: `pleach run docs/dogfood/fail-before-spend/plan.json --repo-root . --max-concurrency 1`, my
slot beside the stem builder, workers claude-opus-5 through umbel, smoke `weeder check --strict`,
audit = tend2 verify on the node's check as a self-integral audit run by opencode +
deepseek/deepseek-v4-pro. Result: 7 of 7 nodes verified in 8 attempts; landed by `pleach land`
(fast-forward, land gate green) onto feat/fail-before-spend at 8986d14; `bun run check` green
(726 tests); every check stamped by `tend2 verify`.

Conducted under D13, D14, D16, D17 and D18. Tried lines read from pleach's own receipts store.

| node | check | attempts | wall | what the extra attempt was |
|---|---|---|---|---|
| fb.validate-commands | c1 | 1 | 10m03s | — |
| fb.cannot-exec | c2 | 1 | 14m40s | — |
| fb.allowlist | c3 | 1 | 13m46s | — |
| fb.schema-optional | c4 | 1 | 6m39s | — |
| fb.facts | c5 | 1 | 17m32s | — |
| fb.docs | c6 | 1 | 10m01s | — |
| fb.e2e | c7 | 2 | 11m45s | the RED gate refused a proof that already passed; the retry found the narration silent on a failed verdict's detail |

### Findings, per node
### fb.validate-commands (verified, 1 attempt(s), 603s, audit pass)
- shellOperatorRefusal() in core/argv.ts is the one message; validatePlan walks work.command / work.test / setup / accept.smoke (never accept.audit.command — relayed to the auditor's shell); an ArgvParseError (unbalanced quote) is a plan fault too; guardedExec reuses the same refusal. `pleach validate` exit 2 naming node + field; run refuses before the lock (validatePlan runs first). Reviewed. #64 closes with the merge.

### fb.cannot-exec (verified, 1 attempt(s), 880s, audit pass)
- gateFault(exitCode) pure in core/classify (-1 → 'plan', 127 → 'environment'); GateCannotRunError typed and classified terminal; setup, smoke and the phase gates (thrown from run-work) route to settleCannotRun → handBack with the tree kept, one attempt, detail naming the fault; the flaky retry never re-runs a -1/127. Reviewed. #69 closes with the merge.

### fb.allowlist (verified, 1 attempt(s), 826s, audit pass)
- DOCUMENTED_EXAMPLE_CREDENTIALS: exact-match, each entry split into stamp + tail so pleach's own diff (gated by this very battery) never carries a whole example; per-entry provenance URL; weeder's X1 PUBLISHED list (src/core/rules/check/x1.rs) cited as the reference, nothing imported. A Stripe secret-key detector was added alongside. Reviewed. #75 closes with the merge. (My earlier grep of weeder's checkout for the whole AWS example missed it because weeder splits it the same way.)

### fb.schema-optional (verified, 1 attempt(s), 399s, audit pass)
- planJsonSchema uses zod's `override` hook to drop `default`/`prefault` keys from every object's `required` (Node and policy alike); the drift test and plan.ts untouched; a minimal plan the validator accepts now validates against the emitted schema. Reviewed. #68 closes with the merge.

### live catch on fb.facts (D14's collector)
- First live `set-aside`: the worker's `.loop-scratch/probe-index.ts`, named absolutely by umbel's manifest, was set aside before the red seal; the seal holds only the test. Under the pre-#88 collector this node would have died at `git add` of an ignored path (#74/#79). The rule earned its keep on the seventh loop.

### fb.facts (verified, 1 attempt(s), 1052s, audit pass)
- IsolateSeam.stagedPaths (git diff --cached --name-only) is what stagedFiles now counts (this receipt: 7, equal to the diff); `spawned` on RunNodeResult → settle → the verdict line (false for a command node, true when a worker spawned) — absent on this run's own verdict lines because the conductor predates the change. Reviewed. #73 and #81 close with the merge.

### fb.docs (verified, 1 attempt(s), 601s, audit pass)
- journal.md: verdict gains `spawned`; README + help say validate refuses shell operators and a gate that cannot run fails once. Reviewed.

### fb.e2e (verified, 2 attempts, 11m45s, whole-page audit 7/7 pass)
- Attempt 1 was refused by the RED gate (the proof already passed against the landed siblings). The retry's honest red: a failed verdict's `detail` — the very sentence that names the fault as the plan's or the environment's — reached the journal but not stderr; narrate now prints it on the line after the verdict. Seventh time this week that gate turned an already-green test into a real defect.
- Three real-CLI scenarios: validate refuses `&&` at exit 2 before anything runs; a smoke naming a missing binary fails the node once, naming the environment, no second worker; `pleach schema` leaves defaulted fields out of `required` and the minimal sibling plan conforms.

### Tools, this run
- pleach: the collector's first live `set-aside` (fb.facts's scratch probe, named absolutely by the editor manifest) — the case that killed finished nodes a week ago now costs nothing. `spawned` is absent from this run's own verdict lines because the conductor predates the change; the next conducted loop will carry it.
- weeder: fb.allowlist cites weeder's X1 PUBLISHED list as the reference for the documented-example allowlist; both split each example into stamp and tail so their own diffs never carry one whole.
- umbel, tend2, pollen: nothing new. `weeder check --strict` green on all seven.

### Issues touched from this loop
- pleach #64, #69, #75, #68, #73, #81 — closed with the merge commit; milestone "Fail before spend" complete.

## Tried lines from the workers' handbacks (the last phase's, verbatim)

One line per node is transcribed onto the page, marked as transcribed from the handback pleach kept
beside the receipt. The kept files are the record; these are copies.

#### fb.validate-commands (c1)
- (handback, kept by pleach at receipts/fb.validate-commands.handback.md) Tried: 2026-09-11 GREEN for c1: `bun run check` and `weeder check --strict` were both already clean, so nothing changed in this phase. The diff is the IMPLEMENT work: one shared message in core/argv.ts, validatePlan walking the four fields, and command-shell-guard.test.ts re-pointed to the plan refusal plus a direct runWork guard case. Next worker: c2 builds on the same guard, since an exit -1 from guardedExec is now unreachable through runPlan for plan-authored commands; the gate-cannot-exec work should target the exec seam's 127 (missing binary, bad cwd).

#### fb.cannot-exec (c2)
- (handback, kept by pleach at receipts/fb.cannot-exec.handback.md) Tried: 2026-09-11 GREEN for c2: ran `bun run check` (exit 0; 673 pass, 0 fail) and `weeder check --strict` on the working-tree diff (0 findings), with no fixes needed after IMPLEMENT; confirmed the evidence test is committed unchanged in the red-phase seal b1b3798; did not run tend2 verify, because the page's check states belong to the verifier. Next worker: the land gate (`land.ts` `gateAndPublish`) still flaky-retries and then bisects on a -1/127, blaming an innocent sink; it needs its own ledger item and failing test.

#### fb.allowlist (c3)
- (handback, kept by pleach at receipts/fb.allowlist.handback.md) Tried: 2026-09-11 GREEN for c3: `bun run check` exited 0 with no further edits (679 pass, 11 skip, 0 fail; tsc and biome clean), and `weeder check --strict` reported 0 findings both against HEAD and across the red and implement phases from 7ba5f90; did not run `tend2 verify` because it writes the loop page, which belongs to the verifier.

#### fb.schema-optional (c4)
- (handback, kept by pleach at receipts/fb.schema-optional.handback.md) Tried: 2026-09-11 GREEN: `bun run check` passed with no edits needed, and a local `weeder check --strict` on the diff had no findings. The only change is src/core/schema-json.ts (zod's `override` hook drops `default`/`prefault` keys from each object's `required`). `io: 'input'` stays rejected because it also drops `additionalProperties: false`.

#### fb.facts (c5)
- (handback, kept by pleach at receipts/fb.facts.handback.md) Tried: 2026-09-11 c5 GREEN: `bun run check` exited 0 (713 tests, 702 pass / 11 skip / 0 fail, tsc and biome clean) and `weeder check --strict` returned zero results, so no code changed this phase. The IMPLEMENT diff (`IsolateSeam.stagedPaths`, index-counted `stagedFiles`, `spawned` on every verdict line via `onSpawn`, the red-seal empty-index guard) is the whole change. I did not run `tend2 verify`, since it writes the page's check state, which belongs to the conductor. Next worker (c6): docs/journal.md must document `verdict`'s `spawned` and change "who ran the work" to "who was cast", because `plotplot.runner` still mirrors `provider` on a `spawned: false` line per the D15 ruling.

#### fb.docs (c6)
- (handback, kept by pleach at receipts/fb.docs.handback.md) Tried: 2026-09-11 GREEN for c6. `bun run check` and `weeder check --strict` both exited 0 on the implement-phase diff (README.md, docs/journal.md, src/faces/cli.ts), so nothing was changed. The only check left open in this loop is c7, the e2e test at test/e2e/fail-before-spend.test.ts.

#### fb.e2e (c7)
- (handback, kept by pleach at receipts/fb.e2e.handback.md) Tried: 2026-09-11 GREEN phase: `bun run check` exits 0 (715 pass, 11 skip, 0 fail) and `weeder check --strict` finds nothing in the diff (src/faces/narrate.ts now narrates a failed verdict's `detail` on the next line; test/unit/narrate.test.ts pins it), so no fix was needed. I left the tend2 verifier to the conductor because the page is read-only for workers. For the auditor: gateFault still reads any exit 127 as the environment's fault, including a started `bash -lc` whose inner command is missing, which classify.ts documents on purpose.
