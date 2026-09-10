# Dogfood — journal-envelope (D15, jahala/pleach#60)

What the pleach agent hit in tend2, pleach, umbel, weeder and pollen while conducting this loop.
The shaping-pass findings that apply to every loop of the 2026-09-08 order are recorded once in
`test-phase-commit.md`; this file carries what this loop's run added.

## Conducting (2026-09-11)

Run: `pleach run docs/dogfood/journal-envelope/plan.json --repo-root . --max-concurrency 1`, the
one agent running (the umbrella's rule after four conductors burned half the owner's window),
workers claude-opus-5 through umbel, smoke `weeder check --strict`, audit = tend2 verify on the
node's check as a self-integral audit run by opencode + deepseek/deepseek-v4-pro, against the
profile at jahala/plotplot v1.4.0 (checked before launch: kinds, required attributes, runner
section and fixture lines match every worker prompt). Result: 6 of 6 nodes verified in 8 attempts;
landed by `pleach land` (fast-forward, land gate green) onto feat/journal-envelope at eb30445;
`bun run check` green (544 tests); every check stamped by `tend2 verify`.

Conducted under D13 and D14: every `node/<id>` reads base → red → verified, and every receipt
names its kept SARIF beside it, its sha256 equal to the sealed `artifactSha` — loop 2's feature
proven live on six consecutive nodes.

| node | check | attempts | wall | what the extra attempt was |
|---|---|---|---|---|
| je.envelope | c1 | 1 | 6m49s | — |
| je.fixture | c2 | 1 | 4m36s | — |
| je.runner | c3 | 1 | 3m38s | — |
| je.seam | c4 | 1 | 7m33s | — |
| je.pin | c5 | 2 | 12m45s | the RED gate refused a pin that already passed |
| je.e2e | c6 | 2 | 16m54s | the RED gate refused a proof that already passed; the retry found the provider-less verdict line |

### Findings, per node
### je.envelope (verified, 1 attempt, 6m49s, audit pass)
- Loop 2's keep fired live: the smoke's SARIF (14 KB, 0 results) is beside the receipt as je.envelope.sarif and its sha256 equals the sealed gates[].artifactSha — the first conducted node whose receipt names an artifact.
- Diff: src/core/journal-envelope.ts (KINDS table pinned to the umbrella's v1.4.0 table; `land-` does not decide the kind, what the line reports does; Object.hasOwn against inherited names; typed JournalEventUnknownError). Reviewed.

### je.fixture (verified, 1 attempt, 4m36s, audit pass)
- MIRRORS by kind (the kind decides which scopes a line has; a required mirror is written null when the line has no such scope — a landing gate belongs to no node); fixture line 2 vendored verbatim with provenance; reproduced key-for-key. Reviewed.

### je.runner (verified, 1 attempt, 3m38s, audit pass)
- plotplot.runner from `provider` verbatim, gen_ai.request.model only when `model` is a string, gen_ai.provider.name never — driven by the fields the line carries, not the event name. Reviewed.

### je.seam (verified, 1 attempt, 7m33s, audit pass)
- envelope() applied once in src/seams/journal.ts (the clock lives at the edge), before mkdir so an unknown event fails loudly with no half-made directory; the narrator tee receives the same enveloped line; docs/journal.md gains "The envelope" (keys, four kinds with mirrors, runner rule). Reviewed.

### je.pin (verified, 2 attempts, 12m45s, audit pass)
- Attempt 1 evidence: --- previous attempt failed; fix this and continue --- Gate 'red' failed (exit 0). Output tail: $ bun run typecheck && bun run lint && bun run test $ tsc --noEmit $ biome check src test 
- The pin now reads the kinds table in docs/journal.md by its own header row and checks it against KINDS both ways; the doc table lists every event under its kind. Reviewed.

### je.e2e (verified, 2 attempts, 16m54s, whole-page audit 6/6 pass)
- Attempt 1: --- previous attempt failed; fix this and continue --- Gate 'red' failed (exit 0). Output tail: $ bun run typecheck && bun run lint && bun run test $ tsc --noEmit 
- The real-CLI proof found the surprise-failure path (a node promise that rejects) wrote a verdict line with no provider, against docs/journal.md's "resolved, never absent"; fixed in run-plan. Every line of a real run now carries the envelope; the verdict names the runner. Reviewed.

### Tools, this run
- pleach: the journal lines still carried no `time` until this loop landed — the monitor that
  watched this run could not tell when a node started (the envelope's `time` closes that).
- pleach: the RED gate refused two tests that already passed (je.pin, je.e2e). Both retries found
  something real (the doc table that let the pin pass vacuously; the provider-less surprise
  verdict). Fourth and fifth time across three loops — the gate is the cheapest reviewer we have.
- umbel/weeder/tend2/pollen: nothing new. `weeder check --strict` green on all six; its SARIF kept
  beside each receipt.

### Issues touched from this loop
- pleach #60 (the loop; closed with the merge commit). The provider-less surprise verdict was fixed
  in-loop (node je.e2e); it is the family of #81 (a verdict's provider when no worker ran) and is
  noted there.

## Tried lines from the workers' handbacks (every phase, verbatim)

One line per node — the implementation phase's — is transcribed onto the page, marked as
transcribed. Every phase's line is kept here. Recovered from Claude Code's own transcripts
(jahala/pleach#66).

#### je.envelope (c1)
- (RED) Tried: 2026-09-10 wrote the c1 RED test at test/unit/journal-envelope.test.ts — table-driven over the exported KINDS rather than a hardcoded mapping (an answer key would just restate the implementation), asserting field-verbatim preservation with event keys first, purity/no-mutation/no-aliasing, injected-clock-only `time`, present-and-null harness + conversation.id, and a typed `JournalEventUnknownError` (with `.event`) for both an unpinned name and a missing/non-string `event`. Proved the assertions sound against a throwaway sketch in `.loop-scratch/` (9/9 pass), then trashed it, so the RED is module-missing and not a typo. Rejected asserting an exact output key set, because c2 legitimately adds `plotplot.node`/`plotplot.gate`. Next worker: `set-aside` is documented in docs/journal.md but absent from the profile summary's kind lists — pin it as `node.lifecycle` (35 documented events) or c5 fails.
- (IMPL) Tried: 2026-09-10 implemented `src/core/journal-envelope.ts` (`Kind`, `KINDS` over all 35 documented events, pure `envelope(event, now)` spreading the event's keys first) plus `JournalEventUnknownError` in core/errors.ts; c1 green 9/9 and `bun run check` green (507 pass, 0 fail). Pinned `set-aside` as `node.lifecycle` — documented in docs/journal.md but missing from the profile summary's lists, and c5's doc pin needs it. Used `Object.hasOwn` for the table lookup rather than a bare index, because a plain object literal answers `KINDS['toString']` from the prototype and would return a bogus kind instead of throwing; rejected a null-prototype table as the equivalent-but-less-readable alternative. Also rejected deriving a `JournalEventName` union from the table, since nothing consumes it yet and the doc/table cross-check is the real exhaustiveness pin. Next worker: the node/gate mirrors go in the same return literal after the universal keys, and c5 still needs docs/journal.md and `KINDS` cross-checked in test/unit/journal-doc.test.ts.
- (GREEN) Tried: 2026-09-10 GREEN phase — ran `bun run check` (exit 0: tsc clean, biome clean over 116 files, 507 pass / 11 skip / 0 fail) and `weeder check --strict` (exit 0, empty results); nothing was red, so no code changed this phase and no biome `--write` was needed. Diff re-read as a hostile reviewer: `src/core/journal-envelope.ts` plus `JournalEventUnknownError` in core/errors.ts, tree otherwise clean, no scratch left behind. Next worker: c2's `plotplot.node`/`plotplot.gate` mirrors and c3's `plotplot.runner`/`gen_ai.request.model` append to the same return literal after `gen_ai.conversation.id` — the event's own keys are spread first, so key order stays as the fixture line has it; c5 still needs docs/journal.md and `KINDS` cross-checked in test/unit/journal-doc.test.ts, where `set-aside` (pinned here as `node.lifecycle`) is the one event the profile summary omits.

#### je.fixture (c2)
- (RED) Tried: 2026-09-10 c2 RED — vendored plotplot contracts/fixtures/friction.jsonl line 2 at v1.1.0 (a8933d5) verbatim into test/fixtures/friction-pleach-line.jsonl by `git show` from the local plotplot clone rather than retyping it from the brief, and wrote test/unit/journal-envelope-fixture.test.ts asserting deep-equality + key-set equality against it plus the mirror rules driven off the whole KINDS table (rejected asserting byte-identical JSON.stringify output, which would pin key order the profile does not require; rejected sample-event assertions, which an answer-key implementation could satisfy). Fails with 5 tests on missing plotplot.node/plotplot.gate; tsc and biome clean, rest of the suite green.
- (IMPL) Tried: 2026-09-10 c2 IMPLEMENT — added a per-kind `MIRRORS` table to src/core/journal-envelope.ts and a loop writing `plotplot.node`/`plotplot.gate` from the event's own fields (`?? null`, so a land-level gate.result line keeps the key with a null value); rejected deriving the mirrors from field presence (an event with a stray field would grow a key its kind doesn't pin) and rejected a per-event mirror table (the profile pins attributes by kind, and a second event-keyed table would drift from KINDS). Full `bun run check` green.
- (GREEN) Tried: 2026-09-10 c2 GREEN — verified the phase with no new edits needed: `bun run check` exits 0 (tsc, biome over 117 files, 514 pass / 0 fail), the fixture test is 7/7 against the vendored plotplot v1.1.0 line, and `weeder check --strict` returns an empty SARIF results array; the only working-tree change is the per-kind `MIRRORS` table in src/core/journal-envelope.ts, with the RED test and fixture already committed at b071cc6, so the next worker appends `plotplot.runner` / `gen_ai.request.model` after the mirror loop rather than reworking it.

#### je.runner (c3)
- (RED) Tried: 2026-09-10 wrote the c3 RED test (test/unit/journal-envelope-runner.test.ts) asserting verbatim `plotplot.runner` from `provider`, `gen_ai.request.model` only when the plan pinned a model (absent, not null), `gen_ai.provider.name` on no event in KINDS, and both original fields unchanged; confirmed RED on the two missing-behaviour assertions with tsc and biome clean. Rejected asserting "only verdict gets plotplot.runner" via a synthetic non-verdict event carrying `provider` — the rule is field-driven, so the honest check is that events which carry no runner gain neither key. Next worker: implement in `envelope()` in src/core/journal-envelope.ts, keyed off the presence of `provider`/`model` on the event, not off the event name.
- (IMPL) Tried: 2026-09-10 implemented c3 in `envelope()` — `plotplot.runner` from `provider` and `gen_ai.request.model` from `model`, both verbatim and both conditional on the field being a string; `bun run check` green, no other file touched. Rejected keying off `event === 'verdict'` (the profile's attribute is about the runner the line names, not the event's name, so a future runner-bearing event would need an edit) and rejected `!== undefined` in favour of a string check (a non-string is not a CLI name, and `core/` must be total). Next worker: the loop's `verdict` append already defaults `provider` via `DEFAULT_WORKER_PROVIDER` and omits `model` when the plan set none, so no run-plan change is needed for c4/c6.
- (GREEN) Tried: 2026-09-10 ran `bun run check` (exit 0: tsc clean, biome clean on 118 files, 520 pass / 11 skip / 0 fail) and `weeder check --strict` (exit 0, no findings) against the working tree; found nothing red, so made no further change — the diff stays the nine-line runner/model addition at the end of `envelope()`. Next worker: c4 (test/integration/journal-envelope.test.ts) needs the journal seam to wrap `append` with `envelope` and a real clock, which is still unwritten; `src/seams/journal.ts` currently serialises the raw event.

#### je.seam (c4)
- (RED) Tried: 2026-09-10 wrote the RED integration test for c4 (test/integration/journal-envelope.test.ts) against the real seam in tmp dirs — full KINDS sweep for envelope keys and per-kind mirrors, land-level null node mirror, loop-shaped field round-trip incl. runner/model, narrator sees the identical enveloped line, throwing narrator still enveloped, and a docs/journal.md content pin; rejected injecting a clock into createJournal (the seam owns it, so `time` is bounded against the wall clock instead) and rejected asserting the doc with toContain (dumped the whole events table on failure — now a missing-terms list); next worker must know that implementing the envelope breaks test/integration/journal.test.ts, which appends `{type:'start'}`/`{type:'stop'}` with no `event` field and will hit JournalEventUnknownError.
- (IMPL) Tried: 2026-09-10 implemented c4 — the journal seam envelopes every append with `envelope(event, new Date())` and tees the same object, plus a `## The envelope` section in docs/journal.md (keys, four kinds and their mirrors, runner attributes, profile source); rejected enveloping at the call sites and rejected a per-seam clock parameter (the seam is the edge, so it holds the clock); the next worker must know two pre-existing tests needed updating because the envelope rejects unnamed events and adds keys — `test/integration/journal.test.ts` now appends real event names, and `test/e2e/gate-artifact.test.ts` pins its journal line with `toMatchObject` plus an explicit "only one line" assertion.
- (GREEN) Tried: 2026-09-10 finished c4 green — kept the seam-level envelope + tee and the docs section, and replaced my earlier `toMatchObject` softening in test/integration/journal.test.ts and test/e2e/gate-artifact.test.ts with exact `toEqual` over a new `ownFields` helper (test/support/journal.ts), so no assertion in the diff is weaker than before; rejected asserting the envelope keys inside those two tests (duplicates the envelope's own pin in tests whose subject is ordering and D14 artifacts) and rejected importing `envelope` into the e2e to build expectations (an answer key against itself); next worker: `ownFields` hardcodes the envelope key set, so a new envelope key must be added there too, and the e2e envelope check (c6) can reuse the helper.

#### je.pin (c5)
- (RED, attempt 1 (refused: already green)) Tried: 2026-09-10 wrote the c5 pin in test/unit/journal-doc.test.ts (new `journal doc — kinds` block, existing assertions byte-identical, `KINDS` imported from src/core/journal-envelope.ts) — both directions plus non-vacuity; it passes on arrival because je.envelope built KINDS from the doc's events table (35 = 35, no diff either way), so no honest RED exists and BLOCKED.md asks for a ruling; proved the pin bites by temporarily adding a `probe-unkinded` doc row and by deleting the `set-aside` row, reverting both; rejected re-scoping c5 to document each event's kind value in docs/journal.md (it duplicates KINDS in prose beside the existing kinds table and would drift); next worker: nothing to implement — `bun run check` is green at 530 pass / 0 fail.
- (RED, attempt 2) Tried: 2026-09-10 c5 RED landed by pinning the doc's kinds table to KINDS (event → stated kind, both directions) after verifying the name-level check the node specified is already satisfied by doc/source/KINDS all being the same 35 names; rejected re-running the previous attempt's BLOCKED.md (true but leaves the check unenforceable) and rejected adding a `kind` column to the events table (35 rows of duplication when the kinds table is the one home for the grouping); green phase = append the event names to the four `lines` cells in `docs/journal.md`, proved sufficient by probe.
- (IMPL) Tried: 2026-09-10 impl phase — named every documented event in the four `lines` cells of the kinds table in docs/journal.md, in the source's grouping order, so the doc states each event's pinned kind and the c5 pin reads it; rejected a per-event `kind` column in the events table (35 rows of duplication for what four rows carry); next worker should know docs/journal.md's kinds table is now the documented home of the event→kind mapping and is pinned to `KINDS` in both directions by test/unit/journal-doc.test.ts, so adding an event means editing both.
- (GREEN) Tried: 2026-09-10 green phase — ran `bun run check` (exit 0: 531 pass, 0 fail, biome and tsc clean) and `weeder check --strict` (exit 0, no findings) against the impl diff, which is only the four kinds-table rows in docs/journal.md; nothing was red so nothing was fixed, and I rejected touching anything else since the check's evidence already passes; next worker: docs/journal.md's kinds table is the documented home of the event→kind mapping and is pinned to `KINDS` both ways by test/unit/journal-doc.test.ts, so a new event needs a row in the events table, a key in `KINDS`, and its name in that kind's `lines` cell.

#### je.e2e (c6)
- (RED, attempt 1 (refused: already green)) Tried: 2026-09-10 wrote test/e2e/journal-envelope.test.ts — a real `pleach run --runner direct-cli` (real git, fake claude, flaky smoke for gate-retry) asserting the envelope on EVERY journal line, kinds restated not imported; it passes on the first run because je.seam already landed the behaviour, so the RED phase is unearnable — falsified it against the pre-envelope seam (fails on missing `time`, restored at once) and swept the failing, SIGINT-aborted and `land` runs plus 24×200 KB concurrent appends, all fully enveloped and untorn; rejected weakening the seam or contriving a defect to force red, and rejected fixing the runnerless-`{command}` verdict claiming `plotplot.runner: "claude"` (mirrors the pre-existing `provider` field this loop declares unchanged, and would contradict verified c3 — its own ledger item) and the catch-all verdict at run-plan.ts:199 that carries no `provider` (unreachable through the CLI, belongs in a loop test); next worker: run c6 as a single verify phase, not red→green, and record the phase-split fault in docs/dogfood/journal-envelope.md — see BLOCKED.md.
- (RED, attempt 2) Tried: 2026-09-10 wrote the c6 e2e RED — refuted the prior worker's "unreachable through the real CLI" claim by running one: a `{prompt}` node cast to a provider `--runner direct-cli` refuses throws out of `runNode`, and run-plan's catch-all verdict (src/loop/run-plan.ts:197) writes no `provider`, so the line carries no `plotplot.runner` against its own doc (`docs/journal.md:29`, "resolved — never absent"). Test now covers both ways a real run reaches a verdict, with the envelope checks shared. Rejected: changing `provider` for `{command}` nodes (contradicts the loop's "existing fields unchanged" and verified c3) and a loop test with a throwing in-memory isolate (c6 is the real-CLI check). Green phase: add provider + model to the catch-all verdict; its missing `attempts`/`telemetry`/`durationMs` are a separate defect, not fixed here. Deleted the stale BLOCKED.md.
- (IMPL) Tried: 2026-09-10 implemented the c6 green — run-plan's catch-all verdict (src/loop/run-plan.ts:197) now resolves `provider` (+`model` when the plan pinned one) like the settled verdict at :394, so `plotplot.runner` and `gen_ai.request.model` land on a verdict however it was reached; both verdict writers in src/ are now identical on this, and `envelope`/core needed no change. Rejected: mirroring a runner in `envelope` from something other than the line's `provider` field (would invent a fact the line does not state, and breaks verified c3), and back-filling `attempts`/`telemetry`/`durationMs` on the surprise line (documented at docs/journal.md:29 but outside this claim — next worker should open a ledger item for it). `bun run check` green: 533 pass, 0 fail.
- (GREEN) Tried: 2026-09-10 verified the green — `bun run check` exits 0 (533 pass, 0 fail), `weeder check --strict` clean, and the c6 evidence test passes three consecutive runs; nothing needed fixing in this phase beyond confirming it. The only working-tree change is run-plan's catch-all verdict resolving `provider` (+`model`) so `plotplot.runner` lands however a verdict was reached; still open for a separate ledger item is that same surprise line's missing `attempts`/`telemetry`/`durationMs`, which docs/journal.md:29 documents on every verdict.
