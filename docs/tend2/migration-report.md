# v1 → v2 migration report

19 file(s) migrated, 0 error(s), 565 dropped field(s) named below, 121 transformation note(s).

## Per-file detail

## agent-output-as-truth (opportunity)

Source: `docs/tend/features/agent-output-as-truth.tend.html` → `agent-output-as-truth.loop.html`

**Dropped fields:**

- `opportunity.source`: no signals count to pair it with; source alone has no v2 Signals line — `internal — three-way verification review + P6 proof run (docs/ledger.md class A; docs/research/proof-run.md)`
- `opportunity.value`: no v2 field for opportunity value tier — `critical`
- `opportunity.confidence`: no v2 field for opportunity confidence tier — `medium`
- `opportunity.personas`: who-feels-this-pain snapshot has no v2 mapping in this pass; add ## For by hand if wanted — `operator`
- `opportunity.solving_features`: denormalized snapshot of solving features has no v2 mapping in this pass; add ## Solved by referencing these ids by hand if wanted — `audit-egress, cli-run, conductor-loop, umbel-seam`
- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `planned`


## audit-egress (loop)

Source: `docs/tend/features/audit-egress.tend.html` → `audit-egress.loop.html`

**Dropped fields:**

- `dek`: v1's own authored dek is superseded by the derived Goal./Who./Pain. dek (what/why) per the migration mapping; original preserved here — `Two pure functions in `src/core/audit-egress.ts` own both halves of the cross-provider audit contract: `buildAuditPrompt` elicits the deterministic fenced block from the stochastic auditor; `extractAuditJson` recovers it from the untruncated reply. Together they ensure a prose-wrapping auditor can n…(truncated)`
- `checks[c001].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c001].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c001].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `extractAuditJson with one block → returns parsed object.`
- `checks[c001].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c001].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c002].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c002].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c002].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Message with two fenced blocks (first has 'fail', second has 'pass'); extractAuditJson → verdicts from second block.`
- `checks[c002].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c002].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c003].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c003].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c003].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `extractAuditJson('no fence here') → throws AuditParseError; err.raw === input.`
- `checks[c003].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c003].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c004].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c004].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c004].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `extractAuditJson with ```tend-audit-result\n{not json}\n```; → AuditParseError.`
- `checks[c004].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c004].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c005].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c005].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c005].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `buildAuditPrompt('audit-cmd') → contains 'audit-cmd', 'tend-audit-result', 'verbatim', and matches /do not summarize/i.`
- `checks[c005].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c005].status`: authoring-state field superseded by the derived check box — `open`
- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `verified`
- `priority`: v2 has no priority enum (FORMAT.md §6) — `medium`
- `progress`: v2 recomputes progress from check state on every read; never stored (FORMAT.md §6) — `{"implementation":100,"verification":100}`
- `thumbnail`: v2 has no thumbnail concept; narrative-referenced <svg> media is the only image path — `{"kind":"svg","alt":"Document rectangle with a fenced-block band highlighted by fence lines — tend-audit-result protocol","content":"<svg viewBox=\"0 0 120 80\" xmlns=\"http://www.w3.org/2000/svg\"><rect class=\"tc-bg tc-frame\" x=\"8\" y=\"8\" width=\"104\" height=\"64\" rx=\"4\"/><rect class=\"tc-…(truncated)`
- `parent`: child-feature parent binding is out of scope for this migration pass — `conductor-loop`
- `journey_phase`: journey-phase concept dropped in v2 per the migration mapping — `build`
- `coverage_files`: v2 has no coverage/code-ownership concept — `["src/core/audit-egress.ts"]`
- `judgments`: v1 slot/coherence judgments have no v2 equivalent — `[{"question_id":"check_discriminates","target":"feature","verdict":"n_a","rationale":"All 5 checks have a discriminating negctrl (exit 0); semantic re-judgment skipped for negctrl-proven checks.","judged_sha":"3d9ed66253caa9774756258db68b65d486fca440"},{"question_id":"impact_measurable","target":"sl…(truncated)`
- `personas_resolved`: denormalized snapshot; the un-resolved personas[] ids already migrated via ## For — `[{"id":"developer","name":"Developer","jobs":["When I add a capability, because I must not let I/O leak into pure logic or a scheduling decision leak into a seam, we believe the layer boundaries make the wrong place to put code obviously wrong. We'll know we got it right when a change lands in exact…(truncated)`
- `audit.result / audit.verified_at_commit / audit.drift`: v2 never stores an audit block — only the verifier's per-check @sha stamp; per-check pass/fail state is honestly reflected in the migrated check boxes (without shas) per the migration's honesty rule — `result=pass, ran_at=2026-06-16T20:10:00Z`

**Transformation notes:**

- c001: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c001: anchored at the runnable test test/unit/audit-egress.test.ts; source module src/core/audit-egress.ts demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- c002: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c002: anchored at the runnable test test/unit/audit-egress.test.ts; source module src/core/audit-egress.ts demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- c003: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c003: anchored at the runnable test test/unit/audit-egress.test.ts; source module src/core/audit-egress.ts demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- c004: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c004: anchored at the runnable test test/unit/audit-egress.test.ts; source module src/core/audit-egress.ts demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- c005: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c005: anchored at the runnable test test/unit/audit-egress.test.ts; source module src/core/audit-egress.ts demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- emitted: ## For #developer #operator (from v1 personas)
- emitted: solves inverted into ## Solved by on agent-output-as-truth
- emitted: solves inverted into ## Solved by on logic-io-entanglement
- 2 intra-map v1 link(s) rewritten to .loop.html


## cli-land (loop)

Source: `docs/tend/features/cli-land.tend.html` → `cli-land.loop.html`

**Dropped fields:**

- `checks[c001].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c001].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c001].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `bun test test/loop/land.test.ts -t 'refuses when any plan node is not closed' — expect pass; negctrl: remove the unclosed guard in src/loop/land.ts → must fail`
- `checks[c001].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c001].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c002].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c002].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c002].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `bun test test/integration/land.test.ts -t 'conflicting sinks refuse' — expect pass; negctrl: skip the merge --abort / conflict throw in IsolateSeam.land → must fail`
- `checks[c002].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c002].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c003].validates`: v2 test lines have no slot-anchor field — `impact`
- `checks[c003].integration_level`: v2 has no verification-surface field — `e2e`
- `checks[c003].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `bun test test/e2e/land.test.ts — expect 3 pass; negctrl: make the --land gating unconditional → the red-run case must fail`
- `checks[c003].validates_job`: persona job-story anchor has no v2 equivalent — `operator:0`
- `checks[c003].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c004].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c004].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c004].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `bun test test/integration/land.test.ts -t 'uncommitted overlapping change' — expect pass; negctrl: replace merge --ff-only with merge → must fail`
- `checks[c004].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c004].status`: authoring-state field superseded by the derived check box — `open`
- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `in-progress`
- `priority`: v2 has no priority enum (FORMAT.md §6) — `high`
- `progress`: v2 recomputes progress from check state on every read; never stored (FORMAT.md §6) — `{"implementation":100,"verification":0}`
- `journey_phase`: journey-phase concept dropped in v2 per the migration mapping — `build`
- `coverage_files`: v2 has no coverage/code-ownership concept — `["src/loop/land.ts"]`
- `smoke`: v2 has no smoke.cmd field; encode a smoke check under ## Tests by hand if still wanted — `{"cmd":"bun test test/e2e/land.test.ts"}`
- `personas_resolved`: denormalized snapshot; the un-resolved personas[] ids already migrated via ## For — `[{"id":"operator","name":"Operator","jobs":["When I hand a multi-step plan to stochastic agents, because I can't personally review every diff and I won't take an agent's word that it 'finished,' we believe only work that mechanically clears the gates should ever land. We'll know we got it right when…(truncated)`

**Transformation notes:**

- c001: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c002: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c003: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c004: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- d001: v1 decision had no "at" date — stamped with the migration date instead of a fabricated original date
- emitted: ## For #operator (from v1 personas)
- emitted: solves inverted into ## Solved by on status-artifact-split


## cli-run (loop)

Source: `docs/tend/features/cli-run.tend.html` → `cli-run.loop.html`

**Dropped fields:**

- `dek`: v1's own authored dek is superseded by the derived Goal./Who./Pain. dek (what/why) per the migration mapping; original preserved here — `pleach run <plan.json> is the operator's handoff point: it parses the plan, wires the seams, fires the conductor loop, and exits with a code that tells the whole story. Exit 0 means every node closed verified; anything less drops to 1, and the RunSummary names the exact buckets.`
- `checks[c001].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c001].integration_level`: v2 has no verification-surface field — `e2e`
- `checks[c001].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `Run `pleach run examples/proof/plan.json --tend-module <missoula> --umbel-bin <umbel>`; expect exit 0 and summary.closed.length === plan.nodes.length.`
- `checks[c001].validates_job`: persona job-story anchor has no v2 equivalent — `operator:0`
- `checks[c001].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c002].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c002].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c002].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Pass a RunSummary with one failed node to summaryExitCode; expect 1. Pass all-closed summary; expect 0.`
- `checks[c002].validates_job`: persona job-story anchor has no v2 equivalent — `operator:4`
- `checks[c002].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c003].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c003].integration_level`: v2 has no verification-surface field — `e2e`
- `checks[c003].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `Run `pleach validate <bad.json>` (missing required fields); expect exit 2 and stderr contains 'pleach:'.`
- `checks[c003].validates_job`: persona job-story anchor has no v2 equivalent — `operator:4`
- `checks[c003].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c004].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c004].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c004].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `Run `pleach run <plan.json>` without --tend-module or env; expect exit 2.`
- `checks[c004].validates_job`: persona job-story anchor has no v2 equivalent — `operator:4`
- `checks[c004].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c005].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c005].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c005].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Acquire lock on same (repoRoot, source) from another process; run pleach run; expect exit 3.`
- `checks[c005].validates_job`: persona job-story anchor has no v2 equivalent — `operator:4`
- `checks[c005].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c006].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c006].integration_level`: v2 has no verification-surface field — `e2e`
- `checks[c006].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `Use flaky.sh node in plan; run pleach run; verify node/e2 branch contains .sentinel (proof second attempt ran).`
- `checks[c006].validates_job`: persona job-story anchor has no v2 equivalent — `operator:0`
- `checks[c006].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c007].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c007].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c007].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `re-run a plan with a node already closed in the ledger; summary.alreadyVerified includes it, summary.closed excludes it, it is never isolated (test/loop/run-plan.test.ts resume).`
- `checks[c007].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c007].status`: authoring-state field superseded by the derived check box — `open`
- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `planned`
- `priority`: v2 has no priority enum (FORMAT.md §6) — `high`
- `progress`: v2 recomputes progress from check state on every read; never stored (FORMAT.md §6) — `{"implementation":0,"verification":0}`
- `thumbnail`: v2 has no thumbnail concept; narrative-referenced <svg> media is the only image path — `{"kind":"svg","alt":"Run triangle flowing into a forking branch — pleach run executor","content":"<svg viewBox=\"0 0 120 80\" xmlns=\"http://www.w3.org/2000/svg\"><rect class=\"tc-bg tc-frame\" x=\"8\" y=\"8\" width=\"104\" height=\"64\" rx=\"4\"/><polygon class=\"tc-wh tc-frame\" points=\"32,20 32,…(truncated)`
- `journey_phase`: journey-phase concept dropped in v2 per the migration mapping — `build`
- `entry_condition`: no v2 structural slot; fold into the narrative by hand if still wanted — `Operator invokes `pleach run <plan.json>`; optionally with `--tend-module <path>` (else the git ledger) and/or `--config <path>` (else the default umbel runner + ledger selection)`
- `exit_condition`: no v2 structural slot; fold into the narrative by hand if still wanted — `JSON RunSummary on stdout; exit 0 (all closed), 1 (any partial/failed/blocked/skipped), 2 (usage/parse error), 3 (lock held)`
- `coverage_files`: v2 has no coverage/code-ownership concept — `["src/faces/cli.ts","src/main.ts","src/core/plan.ts","tsconfig.json"]`
- `judgments`: v1 slot/coherence judgments have no v2 equivalent — `[{"question_id":"check_discriminates","target":"feature","verdict":"n_a","rationale":"negctrl proves discrimination mechanically for c001, c002, c003, c006; semantic re-judgment skipped for negctrl-proven checks.","judged_sha":"4632ab2bc454dd7951d7ca8d4c9f09029086a1b3"},{"question_id":"check_discrim…(truncated)`
- `subpages`: child-feature decomposition is out of scope for this migration pass; re-model as ## Children by hand if wanted — `["conductor-loop","isolate-seam","lock-journal","umbel-seam","tend-seam"]`
- `subpages_resolved`: denormalized snapshot of subpages; see subpages — `[{"id":"conductor-loop","title":"Conductor Loop: DAG Scheduler and Per-Node Ladder","status":"in-progress","priority":"high","personas":["operator","developer"],"solves":["agent-output-as-truth","poison-propagation","status-artifact-split"],"journey_phase":"build","is_subpage":true,"what":"Drives a …(truncated)`
- `personas_resolved`: denormalized snapshot; the un-resolved personas[] ids already migrated via ## For — `[{"id":"operator","name":"Operator","jobs":["When I hand a multi-step plan to stochastic agents, because I can't personally review every diff and I won't take an agent's word that it 'finished,' we believe only work that mechanically clears the gates should ever land. We'll know we got it right when…(truncated)`

**Transformation notes:**

- c001: anchored at the runnable test test/e2e/cli.test.ts; source module examples/proof/plan.json demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- c001: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c003: anchored at the runnable test test/e2e/cli.test.ts; source module bad.json demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- c003: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c004: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c006: anchored at the runnable test test/e2e/cli.test.ts; source module flaky.sh demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- c006: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c007: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- emitted: ## For #operator (from v1 personas)
- emitted: solves inverted into ## Solved by on agent-output-as-truth
- 7 intra-map v1 link(s) rewritten to .loop.html


## cli-validate (loop)

Source: `docs/tend/features/cli-validate.tend.html` → `cli-validate.loop.html`

**Dropped fields:**

- `dek`: v1's own authored dek is superseded by the derived Goal./Who./Pain. dek (what/why) per the migration mapping; original preserved here — ``pleach validate plan.json` runs every structural invariant against a plan before a single agent is spawned — catching cycles, ghost references, and provider collisions in milliseconds so an unattended run never starts on a plan that can't close.`
- `checks[c001].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c001].integration_level`: v2 has no verification-surface field — `e2e`
- `checks[c001].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `Run `pleach validate examples/proof/plan.json`; expect exit 0 and parsed JSON has order[-1] === 'wordcount'.`
- `checks[c001].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c001].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c002].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c002].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c002].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Call validatePlan with two nodes sharing id 'dup'; expect PlanInvalidError with reason containing 'dup'.`
- `checks[c002].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c002].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c003].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c003].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c003].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Call validatePlan with node needs: ['ghost'] where 'ghost' doesn't exist; expect PlanInvalidError mentioning 'ghost'.`
- `checks[c003].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c003].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c004].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c004].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c004].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Call validatePlan with a→b→a cycle; expect PlanInvalidError with cycle in reason.`
- `checks[c004].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c004].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c005].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c005].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c005].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Call validatePlan with node.worker.provider='claude' and audit.provider='claude'; expect PlanInvalidError mentioning diversity or provider.`
- `checks[c005].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c005].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c006].validates`: v2 test lines have no slot-anchor field — `where`
- `checks[c006].integration_level`: v2 has no verification-surface field — `e2e`
- `checks[c006].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `Run `pleach frobnicate x.json`; expect exit 2. Run `pleach`; expect exit 2 and stdout contains 'pleach'.`
- `checks[c006].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c006].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c007].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c007].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c007].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `validatePlan(diamond).waves === [[A],[B,C],[D]] (test/unit/validate-describe.test.ts).`
- `checks[c007].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c007].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c008].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c008].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c008].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `nodeSummaries(plan) entries have correct work + gates (test/unit/validate-describe.test.ts).`
- `checks[c008].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c008].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c009].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c009].integration_level`: v2 has no verification-surface field — `e2e`
- `checks[c009].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `pleach validate <plan> -> stdout JSON has waves (array) + nodes (per-node summary).`
- `checks[c009].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c009].status`: authoring-state field superseded by the derived check box — `open`
- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `in-progress`
- `priority`: v2 has no priority enum (FORMAT.md §6) — `medium`
- `progress`: v2 recomputes progress from check state on every read; never stored (FORMAT.md §6) — `{"implementation":0,"verification":0}`
- `thumbnail`: v2 has no thumbnail concept; narrative-referenced <svg> media is the only image path — `{"kind":"svg","alt":"Bold checkmark over a plan document rectangle — pre-flight validation","content":"<svg viewBox=\"0 0 120 80\" xmlns=\"http://www.w3.org/2000/svg\"><rect class=\"tc-bg tc-frame\" x=\"8\" y=\"8\" width=\"104\" height=\"64\" rx=\"4\"/><rect class=\"tc-wh tc-frame\" x=\"16\" y=\"14\…(truncated)`
- `journey_phase`: journey-phase concept dropped in v2 per the migration mapping — `verify`
- `entry_condition`: no v2 structural slot; fold into the narrative by hand if still wanted — `Operator invokes `pleach validate <plan.json>` with a readable file`
- `exit_condition`: no v2 structural slot; fold into the narrative by hand if still wanted — `Exit 0 with JSON {valid:true, order:[...]} on stdout, or exit 2 with error on stderr`
- `coverage_files`: v2 has no coverage/code-ownership concept — `["src/core/validate.ts"]`
- `judgments`: v1 slot/coherence judgments have no v2 equivalent — `[{"question_id":"check_discriminates","target":"feature","verdict":"n_a","rationale":"negctrl proves discrimination mechanically; semantic re-judgment skipped for negctrl-proven checks.","judged_sha":"9d57c6f7f4bc242fb6c9eccc8030fffe8a73e55b"},{"question_id":"impact_measurable","target":"slots:impac…(truncated)`
- `personas_resolved`: denormalized snapshot; the un-resolved personas[] ids already migrated via ## For — `[{"id":"operator","name":"Operator","jobs":["When I hand a multi-step plan to stochastic agents, because I can't personally review every diff and I won't take an agent's word that it 'finished,' we believe only work that mechanically clears the gates should ever land. We'll know we got it right when…(truncated)`

**Transformation notes:**

- c001: anchored at the runnable test test/e2e/cli.test.ts; source module examples/proof/plan.json demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- c001: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c006: anchored at the runnable test test/e2e/cli.test.ts; source module x.json demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- c006: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c007: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c008: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- emitted: ## For #operator #developer (from v1 personas)
- emitted: solves inverted into ## Solved by on silent-contract-drift
- emitted: solves inverted into ## Solved by on poison-propagation
- 3 intra-map v1 link(s) rewritten to .loop.html


## conductor-loop (loop)

Source: `docs/tend/features/conductor-loop.tend.html` → `conductor-loop.loop.html`

**Dropped fields:**

- `media.node_ladder.alt`: a caption already holds the visible-description slot; the alt text is preserved here — `Per-node execution ladder: isolate → setup → work → marker gate → scoped stage → smoke → audit, with retry loops back from smoke (retryable+evidence) and audit-fail (same tree), and a dead+resume re-isolate loop from work`
- `dek`: v1's own authored dek is superseded by the derived Goal./Who./Pain. dek (what/why) per the migration mapping; original preserved here — `The conductor loop drives a validated Plan to a RunSummary by enforcing a fixed per-node gate ladder, a commit-before-emit invariant, and a classify-then-route retry protocol — together these make pleach's promise concrete: only gates-cleared work ever publishes a branch.`
- `checks[c001].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c001].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c001].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Run diamond plan with maxConcurrency=2; assert h.log.first('commitBranch','node/A') < h.log.first('isolate','B') and < first('isolate','C'); maxConcurrentWorkers <= 2.`
- `checks[c001].validates_job`: persona job-story anchor has no v2 equivalent — `operator:1`
- `checks[c001].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c002].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c002].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c002].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Run plan with one command node + dependent; verify both close and node/cmd ref exists.`
- `checks[c002].validates_job`: persona job-story anchor has no v2 equivalent — `operator:0`
- `checks[c002].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c003].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c003].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c003].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Capture emittedVerdict from harness; assert h.log.first('commitBranch','node/a') < h.log.first('emitVerdict','a') and emittedVerdict.evidence.diffRef === git.refs.get('node/a').`
- `checks[c003].validates_job`: persona job-story anchor has no v2 equivalent — `operator:3`
- `checks[c003].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c004].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c004].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c004].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Set emitDecision → {closed:false}; run plan with audit node + dependent; assert summary.partial contains 'a', summary.failed does not, summary.skipped contains 'b'.`
- `checks[c004].validates_job`: persona job-story anchor has no v2 equivalent — `operator:4`
- `checks[c004].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c005].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c005].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c005].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Seed closed Map with dep→sha; add sha to refs; run plan with dep+child; verify child isolate detail contains sha.`
- `checks[c005].validates_job`: persona job-story anchor has no v2 equivalent — `developer:4`
- `checks[c005].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c006].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c006].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c006].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Seed closed Map with dep→null, no refs; run plan; expect RebuildRequiredError with nodeId='dep' and zero isolate calls.`
- `checks[c006].validates_job`: persona job-story anchor has no v2 equivalent — `operator:3`
- `checks[c006].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c007].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c007].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c007].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `WaitScript returns input for node 'a'; run plan with a+b(needs a); assert blocked=['a'], skipped=['b'], spawn:build count for 'a' is 1.`
- `checks[c007].validates_job`: persona job-story anchor has no v2 equivalent — `operator:2`
- `checks[c007].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c008].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c008].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c008].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `First audit wait returns garbage; second returns valid block; assert buildSpawns=1, auditSpawns=2, summary.closed contains 'a'.`
- `checks[c008].validates_job`: persona job-story anchor has no v2 equivalent — `developer:4`
- `checks[c008].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c009].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c009].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c009].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Override isolate to mutate the closed source map on first call; run x+y(needs x); assert y is isolated once (built, not skipped as pre-closed).`
- `checks[c009].validates_job`: persona job-story anchor has no v2 equivalent — `developer:4`
- `checks[c009].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c010].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c010].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c010].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Run a+b+c(needs a) with maxConcurrency=2 and A's dispose held open until C might isolate; assert h.log.first('isolate','c') > h.log.first('dispose','a').`
- `checks[c010].validates_job`: persona job-story anchor has no v2 equivalent — `developer:4`
- `checks[c010].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c011].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c011].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c011].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Seed closed Map with I→sha (I needs S); run S+I+next(needs I); assert isolate count for S=0, I=0, next=1.`
- `checks[c011].validates_job`: persona job-story anchor has no v2 equivalent — `developer:4`
- `checks[c011].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c012].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c012].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c012].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Override scanMarkers to return dirty on second call; run audit node; assert summary.failed contains 'a' and git.refs has no 'node/a'.`
- `checks[c012].validates_job`: persona job-story anchor has no v2 equivalent — `operator:0`
- `checks[c012].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c013].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c013].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c013].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Run node with setup+smoke+audit in harness; assert log ordering: isolate < setup-exec < send < scanMarkers < stage < smoke-exec < spawn:audit.`
- `checks[c013].validates_job`: persona job-story anchor has no v2 equivalent — `developer:4`
- `checks[c013].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c014].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c014].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c014].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Run any node; assert h.log.count('kill', nodeId) >= 1.`
- `checks[c014].validates_job`: persona job-story anchor has no v2 equivalent — `developer:4`
- `checks[c014].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c015].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c015].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c015].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Smoke returns 'SMOKE-OUTPUT-XYZ' exit 1; maxAttempts=2; assert last send detail contains 'SMOKE-OUTPUT-XYZ'.`
- `checks[c015].validates_job`: persona job-story anchor has no v2 equivalent — `developer:4`
- `checks[c015].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c016].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c016].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c016].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Call runWork with command node; exec returns exit 0 → reason='stop'; exec returns exit 3 → throws GateFailedError with gate='command'.`
- `checks[c016].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c016].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c017].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c017].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c017].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Run phases node with exec always returning exit 0 → GateFailedError(red). Run with exit 1 on both → GateFailedError(green).`
- `checks[c017].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c017].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c018].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c018].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c018].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `runNode a {command} node with a runner whose spawnWorker throws -> status 'done', spawn:build count 0 (test/loop/run-node.test.ts lazy worker spawn).`
- `checks[c018].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c018].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c019].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c019].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c019].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `runPlan with a pre-closed node -> summary.alreadyVerified includes it, summary.closed excludes it, never isolated (test/loop/run-plan.test.ts resume).`
- `checks[c019].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c019].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c020].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c020].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c020].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `runNode a node with accept.audit.model set -> the audit spawnWorker spec carries that model (test/loop/run-node.test.ts audit.model).`
- `checks[c020].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c020].status`: authoring-state field superseded by the derived check box — `open`
- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `in-progress`
- `priority`: v2 has no priority enum (FORMAT.md §6) — `high`
- `progress`: v2 recomputes progress from check state on every read; never stored (FORMAT.md §6) — `{"implementation":0,"verification":0}`
- `thumbnail`: v2 has no thumbnail concept; narrative-referenced <svg> media is the only image path — `{"kind":"svg","alt":"DAG diamond: top node to two middle nodes to one bottom node — conductor scheduler","content":"<svg viewBox=\"0 0 120 80\" xmlns=\"http://www.w3.org/2000/svg\"><rect class=\"tc-bg tc-frame\" x=\"8\" y=\"8\" width=\"104\" height=\"64\" rx=\"4\"/><circle class=\"tc-wh tc-frame\" c…(truncated)`
- `parent`: child-feature parent binding is out of scope for this migration pass — `cli-run`
- `journey_phase`: journey-phase concept dropped in v2 per the migration mapping — `build`
- `coverage_files`: v2 has no coverage/code-ownership concept — `["src/loop/run-plan.ts","src/loop/run-node.ts","src/loop/run-work.ts","src/loop/deps.ts","src/core/classify.ts","src/core/errors.ts","src/core/argv.ts","src/seams/exec.ts"]`
- `judgments`: v1 slot/coherence judgments have no v2 equivalent — `[{"question_id":"check_discriminates","target":"feature","verdict":"n_a","rationale":"negctrl proves discrimination mechanically; semantic re-judgment skipped for negctrl-proven checks.","judged_sha":"0082751d21a0ccf4895fc10e6c093867f31bf3ee"},{"question_id":"impact_measurable","target":"slots:impac…(truncated)`
- `subpages`: child-feature decomposition is out of scope for this migration pass; re-model as ## Children by hand if wanted — `["audit-egress"]`
- `subpages_resolved`: denormalized snapshot of subpages; see subpages — `[{"id":"audit-egress","title":"Audit Egress: Fenced Block Protocol","status":"verified","priority":"medium","personas":["developer","operator"],"solves":["agent-output-as-truth","logic-io-entanglement"],"journey_phase":"build","is_subpage":true,"what":"Extracts the LAST ```tend-audit-result fenced b…(truncated)`
- `personas_resolved`: denormalized snapshot; the un-resolved personas[] ids already migrated via ## For — `[{"id":"operator","name":"Operator","jobs":["When I hand a multi-step plan to stochastic agents, because I can't personally review every diff and I won't take an agent's word that it 'finished,' we believe only work that mechanically clears the gates should ever land. We'll know we got it right when…(truncated)`

**Transformation notes:**

- c018: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c019: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c020: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- emitted: ## For #operator #developer (from v1 personas)
- emitted: solves inverted into ## Solved by on agent-output-as-truth
- emitted: solves inverted into ## Solved by on poison-propagation
- emitted: solves inverted into ## Solved by on status-artifact-split
- 2 intra-map v1 link(s) rewritten to .loop.html


## developer (persona)

Source: `docs/tend/features/developer.tend.html` → `developer.loop.html`

**Dropped fields:**

- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `planned`


## isolate-seam (loop)

Source: `docs/tend/features/isolate-seam.tend.html` → `isolate-seam.loop.html`

**Dropped fields:**

- `media.lifecycle.alt`: a caption already holds the visible-description slot; the alt text is preserved here — `isolate() merge flow: worktree add, then per-ref merge with three outcomes — clean continues, conflict commits markers and continues, catastrophic aborts and throws`
- `dek`: v1's own authored dek is superseded by the derived Goal./Who./Pain. dek (what/why) per the migration mapping; original preserved here — `Every plan node gets a disposable git worktree off its verified dependencies. Conflict markers are committed in-place for the agent to see—then caught by a fail-closed gate before any verified branch is published. A scoped stage and a 40-char SHA are the seam's only outputs.`
- `checks[c001].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c001].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c001].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Call seam.isolate twice in parallel on same baseRef; assert both isoA.cwd and isoB.cwd have the expected file and cwd paths differ.`
- `checks[c001].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c001].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c002].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c002].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c002].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Two branches write different content to shared.txt; isolate with both as baseRefs; assert conflictFiles contains 'shared.txt' and file content has '<<<<<<<'.`
- `checks[c002].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c002].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c003].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c003].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c003].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Two branches write different filenames; isolate with both; assert conflictFiles=[]; both files exist in cwd.`
- `checks[c003].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c003].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c004].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c004].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c004].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Isolate with [existing-ref, ghost-does-not-exist]; expect IsolateCatastrophicError; git worktree list shows only main worktree.`
- `checks[c004].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c004].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c005].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c005].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c005].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Isolate conflicting branches; scanMarkers → contains 'scan.txt'; write resolved content; scanMarkers → [].`
- `checks[c005].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c005].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c006].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c006].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c006].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Write real.txt (staged) and junk.txt (not staged); commitBranch; git show --stat must contain real.txt and not junk.txt.`
- `checks[c006].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c006].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c007].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c007].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c007].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Stage a file; commitBranch returns sha matching /^[0-9a-f]{40}$/; refSha(branch) === sha; commitBranch with nothing staged also succeeds.`
- `checks[c007].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c007].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c008].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c008].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c008].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Isolate; dispose; git worktree list --porcelain must not contain cwd path; second dispose resolves without throwing.`
- `checks[c008].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c008].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c009].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c009].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c009].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Call seam.scanMarkers('/nonexistent-path'); expect IsolateCatastrophicError (never report clean).`
- `checks[c009].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c009].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c010].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c010].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c010].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Modify a tracked file, add untracked unignored file, add gitignored file; changedFiles includes modified+untracked, excludes ignored.`
- `checks[c010].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c010].status`: authoring-state field superseded by the derived check box — `open`
- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `verified`
- `priority`: v2 has no priority enum (FORMAT.md §6) — `high`
- `progress`: v2 recomputes progress from check state on every read; never stored (FORMAT.md §6) — `{"implementation":100,"verification":100}`
- `thumbnail`: v2 has no thumbnail concept; narrative-referenced <svg> media is the only image path — `{"kind":"svg","alt":"Vertical branch line forking into a dashed rectangle — git worktree isolation","content":"<svg viewBox=\"0 0 120 80\" xmlns=\"http://www.w3.org/2000/svg\"><rect class=\"tc-bg tc-frame\" x=\"8\" y=\"8\" width=\"104\" height=\"64\" rx=\"4\"/><line class=\"tc-ln\" x1=\"40\" y1=\"14…(truncated)`
- `parent`: child-feature parent binding is out of scope for this migration pass — `cli-run`
- `journey_phase`: journey-phase concept dropped in v2 per the migration mapping — `build`
- `coverage_files`: v2 has no coverage/code-ownership concept — `["src/seams/isolate.ts"]`
- `judgments`: v1 slot/coherence judgments have no v2 equivalent — `[{"question_id":"check_discriminates","target":"feature","verdict":"n_a","rationale":"negctrl proves discrimination mechanically; semantic re-judgment skipped for negctrl-proven checks.","judged_sha":"75abde34336a48c4e9d2f907c67c10ad8774eddc"}]`
- `personas_resolved`: denormalized snapshot; the un-resolved personas[] ids already migrated via ## For — `[{"id":"developer","name":"Developer","jobs":["When I add a capability, because I must not let I/O leak into pure logic or a scheduling decision leak into a seam, we believe the layer boundaries make the wrong place to put code obviously wrong. We'll know we got it right when a change lands in exact…(truncated)`
- `audit.result / audit.verified_at_commit / audit.drift`: v2 never stores an audit block — only the verifier's per-check @sha stamp; per-check pass/fail state is honestly reflected in the migrated check boxes (without shas) per the migration's honesty rule — `result=pass, ran_at=2026-08-16, verified_at_commit=9e28318d41abc0a24c69924ed519d9933c492701`

**Transformation notes:**

- c001: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c002: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c003: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c004: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c005: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c006: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c007: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c008: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c009: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c010: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- emitted: ## For #developer #operator (from v1 personas)
- emitted: solves inverted into ## Solved by on poison-propagation
- emitted: solves inverted into ## Solved by on status-artifact-split
- emitted: solves inverted into ## Solved by on logic-io-entanglement
- 3 intra-map v1 link(s) rewritten to .loop.html


## lock-journal (loop)

Source: `docs/tend/features/lock-journal.tend.html` → `lock-journal.loop.html`

**Dropped fields:**

- `dek`: v1's own authored dek is superseded by the derived Goal./Who./Pain. dek (what/why) per the migration mapping; original preserved here — `Two seams gate every run: a PID lockfile stops two conductors from racing the same repo, and a JSONL journal records every scheduling decision so a developer can replay what happened without re-running any agent.`
- `checks[c001].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c001].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c001].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `acquire(repoRoot, 'test-source'); acquire again → LockHeldError with pid === process.pid.`
- `checks[c001].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c001].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c002].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c002].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c002].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `acquire → release → acquire again → no error.`
- `checks[c002].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c002].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c003].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c003].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c003].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Plant lockfile with dead pid 999999; acquire → succeeds; lockfile content === process.pid.`
- `checks[c003].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c003].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c004].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c004].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c004].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `acquire; read .git/pleach-{sha}.lock; Number(content) === process.pid.`
- `checks[c004].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c004].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c005].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c005].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c005].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Run plan in harness; h.journal.map(e=>e.event) contains 'run-start' and 'run-end'.`
- `checks[c005].validates_job`: persona job-story anchor has no v2 equivalent — `developer:4`
- `checks[c005].status`: authoring-state field superseded by the derived check box — `open`
- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `verified`
- `priority`: v2 has no priority enum (FORMAT.md §6) — `medium`
- `progress`: v2 recomputes progress from check state on every read; never stored (FORMAT.md §6) — `{"implementation":100,"verification":100}`
- `thumbnail`: v2 has no thumbnail concept; narrative-referenced <svg> media is the only image path — `{"kind":"svg","alt":"Padlock beside three stacked lines — run lock and JSONL trace","content":"<svg viewBox=\"0 0 120 80\" xmlns=\"http://www.w3.org/2000/svg\"><rect class=\"tc-bg tc-frame\" x=\"8\" y=\"8\" width=\"104\" height=\"64\" rx=\"4\"/><rect class=\"tc-wh tc-frame\" x=\"20\" y=\"38\" width=…(truncated)`
- `parent`: child-feature parent binding is out of scope for this migration pass — `cli-run`
- `journey_phase`: journey-phase concept dropped in v2 per the migration mapping — `build`
- `coverage_files`: v2 has no coverage/code-ownership concept — `["src/seams/lock.ts","src/seams/journal.ts","src/seams/gitdir.ts"]`
- `judgments`: v1 slot/coherence judgments have no v2 equivalent — `[{"question_id":"check_discriminates","target":"feature","verdict":"n_a","rationale":"negctrl proves discrimination mechanically; semantic re-judgment skipped for negctrl-proven checks.","judged_sha":"6d1421a92a6fcefd8278552f59118251cc16b249"}]`
- `personas_resolved`: denormalized snapshot; the un-resolved personas[] ids already migrated via ## For — `[{"id":"developer","name":"Developer","jobs":["When I add a capability, because I must not let I/O leak into pure logic or a scheduling decision leak into a seam, we believe the layer boundaries make the wrong place to put code obviously wrong. We'll know we got it right when a change lands in exact…(truncated)`
- `audit.result / audit.verified_at_commit / audit.drift`: v2 never stores an audit block — only the verifier's per-check @sha stamp; per-check pass/fail state is honestly reflected in the migrated check boxes (without shas) per the migration's honesty rule — `result=pass, ran_at=2026-08-16, verified_at_commit=9e28318d41abc0a24c69924ed519d9933c492701`

**Transformation notes:**

- c001: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c001: anchored at the runnable test test/integration/lock.test.ts; source module src/seams/lock.ts demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- c002: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c002: anchored at the runnable test test/integration/lock.test.ts; source module src/seams/lock.ts demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- c003: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c003: anchored at the runnable test test/integration/lock.test.ts; source module src/seams/lock.ts demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- c004: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c004: anchored at the runnable test test/integration/lock.test.ts; source module src/seams/lock.ts demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- c005: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c005: anchored at the runnable test test/loop/run-plan.test.ts; source module src/loop/run-plan.ts demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- emitted: ## For #developer (from v1 personas)
- emitted: solves inverted into ## Solved by on logic-io-entanglement
- 3 intra-map v1 link(s) rewritten to .loop.html


## logic-io-entanglement (opportunity)

Source: `docs/tend/features/logic-io-entanglement.tend.html` → `logic-io-entanglement.loop.html`

**Dropped fields:**

- `opportunity.source`: no signals count to pair it with; source alone has no v2 Signals line — `internal — engineering doctrine (ENGINEERING.md, S.U.P.E.R.)`
- `opportunity.value`: no v2 field for opportunity value tier — `high`
- `opportunity.confidence`: no v2 field for opportunity confidence tier — `medium`
- `opportunity.personas`: who-feels-this-pain snapshot has no v2 mapping in this pass; add ## For by hand if wanted — `developer`
- `opportunity.solving_features`: denormalized snapshot of solving features has no v2 mapping in this pass; add ## Solved by referencing these ids by hand if wanted — `audit-egress, isolate-seam, lock-journal, pluggable-adapters, tend-seam, umbel-seam`
- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `planned`


## operator (persona)

Source: `docs/tend/features/operator.tend.html` → `operator.loop.html`

**Dropped fields:**

- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `planned`


## pluggable-adapters (loop)

Source: `docs/tend/features/pluggable-adapters.tend.html` → `pluggable-adapters.loop.html`

**Dropped fields:**

- `checks[c001].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c001].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c001].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `resolveSeams({config: custom-fixture-path, repoRoot, umbelBin, permissionMode}) → the resolved ledger.readClosed('x') contains the fixture's sentinel key (test/integration/config-resolve.test.ts).`
- `checks[c001].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c001].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c002].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c002].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c002].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `resolveSeams({repoRoot: temp-git-repo-with-node/foo, umbelBin, permissionMode}) → ledger.readClosed('x') returns a Map containing 'foo' (test/integration/config-resolve.test.ts).`
- `checks[c002].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c002].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c003].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c003].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c003].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `resolveSeams({config:'/no/such/pleach.config.ts'}) and a config missing the `ledger` export → both reject with ConfigError (test/integration/config-resolve.test.ts).`
- `checks[c003].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c003].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c004].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c004].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c004].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `gitLedger({repo}) on a repo with node/foo, node/bar (+ feature/x) → Map{foo,bar} stripped of the node/ prefix, feature/x excluded; emitVerdict done→{closed:true}, failed→{closed:false}; non-git dir → LedgerError (test/integration/git-ledger.test.ts).`
- `checks[c004].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c004].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c005].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c005].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c005].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `planJsonSchema() → an object with a properties map describing the plan's nodes/goal/source fields (test/unit/plan-schema-export.test.ts).`
- `checks[c005].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c005].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c006].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c006].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c006].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `import { runPlan, buildDeps, validatePlan, planJsonSchema, PlanInvalidError } from 'pleach' — all defined; runPlan/buildDeps are functions (test/unit/library-export.test.ts).`
- `checks[c006].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c006].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c007].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c007].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c007].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `buildDeps({repoRoot, runner, ledger}) returns deps with exec/isolate/lock/journal/runner/ledger all present (test/unit/library-export.test.ts).`
- `checks[c007].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c007].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c008].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c008].integration_level`: v2 has no verification-surface field — `e2e`
- `checks[c008].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `bun test test/e2e/direct-cli.test.ts — expect 3 pass (verified close via fake claude/codex binaries on PATH; --runner validation; --config conflict); negctrl: break the runnerKind branch in resolveSeams → must fail`
- `checks[c008].validates_job`: persona job-story anchor has no v2 equivalent — `operator:0`
- `checks[c008].status`: authoring-state field superseded by the derived check box — `open`
- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `in-progress`
- `priority`: v2 has no priority enum (FORMAT.md §6) — `high`
- `progress`: v2 recomputes progress from check state on every read; never stored (FORMAT.md §6) — `{"implementation":100,"verification":0}`
- `thumbnail`: v2 has no thumbnail concept; narrative-referenced <svg> media is the only image path — `{"kind":"svg","alt":"A central port box with one solid adapter plugged in on the left and one dashed swappable adapter on the right — pluggable runner/ledger","content":"<svg viewBox=\"0 0 120 80\" xmlns=\"http://www.w3.org/2000/svg\"><rect class=\"tc-bg tc-frame\" x=\"8\" y=\"8\" width=\"104\" heig…(truncated)`
- `journey_phase`: journey-phase concept dropped in v2 per the migration mapping — `build`
- `coverage_files`: v2 has no coverage/code-ownership concept — `["src/adapters/git.ts","src/faces/config.ts","src/core/schema-json.ts","src/index.ts","src/adapters/direct-cli.ts"]`
- `smoke`: v2 has no smoke.cmd field; encode a smoke check under ## Tests by hand if still wanted — `{"cmd":"bun test test/integration/config-resolve.test.ts test/e2e/direct-cli.test.ts"}`
- `personas_resolved`: denormalized snapshot; the un-resolved personas[] ids already migrated via ## For — `[{"id":"developer","name":"Developer","jobs":["When I add a capability, because I must not let I/O leak into pure logic or a scheduling decision leak into a seam, we believe the layer boundaries make the wrong place to put code obviously wrong. We'll know we got it right when a change lands in exact…(truncated)`

**Transformation notes:**

- c001: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c002: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c003: anchored at the runnable test test/integration/config-resolve.test.ts; source module /no/such/pleach.config.ts demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- c003: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c004: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c005: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c006: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c007: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c008: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- d001: v1 decision had no "at" date — stamped with the migration date instead of a fabricated original date
- emitted: ## For #developer #operator (from v1 personas)
- emitted: solves inverted into ## Solved by on logic-io-entanglement
- 2 intra-map v1 link(s) rewritten to .loop.html


## poison-propagation (opportunity)

Source: `docs/tend/features/poison-propagation.tend.html` → `poison-propagation.loop.html`

**Dropped fields:**

- `opportunity.source`: no signals count to pair it with; source alone has no v2 Signals line — `internal — adversarial review (docs/ledger.md C1, A1)`
- `opportunity.value`: no v2 field for opportunity value tier — `high`
- `opportunity.confidence`: no v2 field for opportunity confidence tier — `medium`
- `opportunity.personas`: who-feels-this-pain snapshot has no v2 mapping in this pass; add ## For by hand if wanted — `operator`
- `opportunity.solving_features`: denormalized snapshot of solving features has no v2 mapping in this pass; add ## Solved by referencing these ids by hand if wanted — `cli-validate, conductor-loop, isolate-seam`
- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `planned`


## scripted-runner (loop)

Source: `docs/tend/features/scripted-runner.tend.html` → `scripted-runner.loop.html`

**Dropped fields:**

- `checks[c001].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c001].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c001].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `spawnWorker({provider,cwd}); send a prompt containing the scenario's substring; wait() writes the scenario files into cwd and returns finalMessage + filesTouched + reason='stop' (test/unit/scripted-runner.test.ts).`
- `checks[c001].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c001].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c002].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c002].integration_level`: v2 has no verification-surface field — `unit`
- `checks[c002].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `AuditResultSchema.parse(extractAuditJson(scriptedAuditResult([{check,verdict:'pass'}]))) succeeds with verdict 'pass' (test/unit/scripted-runner.test.ts).`
- `checks[c002].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c002].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c003].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c003].integration_level`: v2 has no verification-surface field — `e2e`
- `checks[c003].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `run test/e2e/examples.test.ts command-dag against a temp repo; summary closed=[check,lib], failed=[broken], skipped=[dependent]; node/* branches present for closed only.`
- `checks[c003].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c003].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c004].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c004].integration_level`: v2 has no verification-surface field — `e2e`
- `checks[c004].verification_recipe`: kept only as a best-effort evidence-path extraction; the full recipe text is preserved here — `run test/e2e/examples.test.ts scripted-agent against a temp repo; summary.closed=[harden,implement]; node/implement + node/harden branches present.`
- `checks[c004].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c004].status`: authoring-state field superseded by the derived check box — `open`
- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `in-progress`
- `progress`: v2 recomputes progress from check state on every read; never stored (FORMAT.md §6) — `{"implementation":0,"verification":0}`
- `journey_phase`: journey-phase concept dropped in v2 per the migration mapping — `build`
- `entry_condition`: no v2 structural slot; fold into the narrative by hand if still wanted — `A planner has a plan.json and wants to run or demo it without an interactive agent runner or API keys.`
- `exit_condition`: no v2 structural slot; fold into the narrative by hand if still wanted — `The plan runs to verified closes (and quarantines) deterministically — node/<id> branches published — with no external runner binary and no API keys.`
- `coverage_files`: v2 has no coverage/code-ownership concept — `["src/adapters/scripted.ts"]`

**Transformation notes:**

- c001: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c002: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c003: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path
- c004: evidence field is a best-effort path pulled from verification_recipe, not an audited evidence_path


## silent-contract-drift (opportunity)

Source: `docs/tend/features/silent-contract-drift.tend.html` → `silent-contract-drift.loop.html`

**Dropped fields:**

- `opportunity.source`: no signals count to pair it with; source alone has no v2 Signals line — `internal — contract design (ENGINEERING.md, docs/contract/)`
- `opportunity.value`: no v2 field for opportunity value tier — `high`
- `opportunity.confidence`: no v2 field for opportunity confidence tier — `medium`
- `opportunity.personas`: who-feels-this-pain snapshot has no v2 mapping in this pass; add ## For by hand if wanted — `developer`
- `opportunity.solving_features`: denormalized snapshot of solving features has no v2 mapping in this pass; add ## Solved by referencing these ids by hand if wanted — `cli-validate`
- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `planned`


## status-artifact-split (opportunity)

Source: `docs/tend/features/status-artifact-split.tend.html` → `status-artifact-split.loop.html`

**Dropped fields:**

- `opportunity.source`: no signals count to pair it with; source alone has no v2 Signals line — `internal — adversarial review (docs/ledger.md B1/B2)`
- `opportunity.value`: no v2 field for opportunity value tier — `high`
- `opportunity.confidence`: no v2 field for opportunity confidence tier — `medium`
- `opportunity.personas`: who-feels-this-pain snapshot has no v2 mapping in this pass; add ## For by hand if wanted — `operator`
- `opportunity.solving_features`: denormalized snapshot of solving features has no v2 mapping in this pass; add ## Solved by referencing these ids by hand if wanted — `cli-land, conductor-loop, isolate-seam, tend-seam`
- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `planned`


## tend-seam (loop)

Source: `docs/tend/features/tend-seam.tend.html` → `tend-seam.loop.html`

**Dropped fields:**

- `media.ingester_queue.alt`: a caption already holds the visible-description slot; the alt text is preserved here — `Three concurrent emitVerdict callers funneling through a FIFO promise-chain queue into a single tend ledger transport`
- `dek`: v1's own authored dek is superseded by the derived Goal./Who./Pain. dek (what/why) per the migration mapping; original preserved here — `The tend ledger adapter is the single serial writer between pleach's execution verdicts and tend's verifiable ledger. It serializes concurrent node completions through a FIFO promise-chain queue, adapts tend's pre-SHA return format, and translates polyglot paths to project roots — so the ledger alwa…(truncated)`
- `checks[c001].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c001].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c001].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Write a temp TS file exporting only 'notATransport'; createModuleTransport(badPath) → TendTransportError.`
- `checks[c001].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c001].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c002].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c002].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c002].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `createModuleTransport('/nonexistent/ingester.ts') → TendTransportError.`
- `checks[c002].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c002].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c003].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c003].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c003].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Seed minimal catalog with no features; createTendSeam(transport).readClosed(root) → instanceof Map, size 0.`
- `checks[c003].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c003].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c004].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c004].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c004].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Seed catalog with 'feat-verified' (verified) and 'feat-progress' (in-progress); readClosed → has('feat-verified')=true, has('feat-progress')=false; get('feat-verified')===null (pre-T1 no SHA).`
- `checks[c004].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c004].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c005].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c005].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c005].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Seed in-progress feature; emitVerdict(failedVerdict) → {closed:false}; readFeature after → status still 'in-progress', audit undefined.`
- `checks[c005].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c005].status`: authoring-state field superseded by the derived check box — `open`
- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `planned`
- `priority`: v2 has no priority enum (FORMAT.md §6) — `high`
- `progress`: v2 recomputes progress from check state on every read; never stored (FORMAT.md §6) — `{"implementation":0,"verification":80}`
- `thumbnail`: v2 has no thumbnail concept; narrative-referenced <svg> media is the only image path — `{"kind":"svg","alt":"Funnel of three lines converging to a single line into a ledger bar — serial queue to one writer","content":"<svg viewBox=\"0 0 120 80\" xmlns=\"http://www.w3.org/2000/svg\"><rect class=\"tc-bg tc-frame\" x=\"8\" y=\"8\" width=\"104\" height=\"64\" rx=\"4\"/><line class=\"tc-ln\…(truncated)`
- `parent`: child-feature parent binding is out of scope for this migration pass — `cli-run`
- `journey_phase`: journey-phase concept dropped in v2 per the migration mapping — `build`
- `coverage_files`: v2 has no coverage/code-ownership concept — `["src/adapters/tend.ts"]`
- `judgments`: v1 slot/coherence judgments have no v2 equivalent — `[{"question_id":"check_discriminates","target":"feature","verdict":"n_a","rationale":"negctrl proves discrimination mechanically for c001, c002, c004, c005; semantic re-judgment skipped for negctrl-proven checks. c003 did not discriminate — recorded as partial with specific gap noted.","judged_sha":…(truncated)`
- `personas_resolved`: denormalized snapshot; the un-resolved personas[] ids already migrated via ## For — `[{"id":"developer","name":"Developer","jobs":["When I add a capability, because I must not let I/O leak into pure logic or a scheduling decision leak into a seam, we believe the layer boundaries make the wrong place to put code obviously wrong. We'll know we got it right when a change lands in exact…(truncated)`
- `audit.result / audit.verified_at_commit / audit.drift`: v2 never stores an audit block — only the verifier's per-check @sha stamp; per-check pass/fail state is honestly reflected in the migrated check boxes (without shas) per the migration's honesty rule — `result=partial, ran_at=2026-06-16T20:10:00Z, drift=1 entry`

**Transformation notes:**

- c001: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c001: anchored at the runnable test test/integration/tend-seam.test.ts; source module src/adapters/tend.ts demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- c002: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c002: anchored at the runnable test test/integration/tend-seam.test.ts; source module src/adapters/tend.ts demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- c003: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c003: anchored at the runnable test test/integration/tend-seam.test.ts; source module src/adapters/tend.ts demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- c004: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c004: anchored at the runnable test test/integration/tend-seam.test.ts; source module src/adapters/tend.ts demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- c005: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c005: anchored at the runnable test test/integration/tend-seam.test.ts; source module src/adapters/tend.ts demoted to a prose note (an unrunnable anchor can never re-earn its stamp)
- emitted: ## For #developer #operator (from v1 personas)
- emitted: solves inverted into ## Solved by on status-artifact-split
- emitted: solves inverted into ## Solved by on logic-io-entanglement
- 2 intra-map v1 link(s) rewritten to .loop.html


## umbel-seam (loop)

Source: `docs/tend/features/umbel-seam.tend.html` → `umbel-seam.loop.html`

**Dropped fields:**

- `media.worker_lifecycle.alt`: a caption already holds the visible-description slot; the alt text is preserved here — `Worker lifecycle flow: spawnWorker produces a Worker, send captures sinceMtime and flows into wait which branches on reason — stop leads to read/actions/diff then kill; dead/timeout/aborted lead directly to kill; input/idle surface as blocked. A dashed arrow shows the send→wait loop repeating for multi-turn conversations.`
- `dek`: v1's own authored dek is superseded by the derived Goal./Who./Pain. dek (what/why) per the migration mapping; original preserved here — `The bundled umbel runner adapter is one channel between pleach's deterministic loop and a stochastic agent: spawn→send→wait→kill over the umbel binary, with sinceMtime threading to make stop detection race-free and typed reasons — stop, dead, timeout, aborted, input, idle — so the loop never holds a…(truncated)`
- `checks[c001].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c001].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c001].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `Make seam with allowedTools + bypassPermissions; spawnWorker; send 'hello from pleach'; wait(30s); assert reason='stop', finalMessage contains prompt, manifest.turnCount is number.`
- `checks[c001].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c001].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c002].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c002].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c002].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `send 'turn one'; wait → r1.reason='stop'; send 'turn two'; wait → r2.finalMessage contains 'turn two'.`
- `checks[c002].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c002].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c003].validates`: v2 test lines have no slot-anchor field — `how`
- `checks[c003].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c003].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `send; wait → stop; wait again with 2s timeout (no send); expect reason='timeout' and finalMessage=''.`
- `checks[c003].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c003].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c004].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c004].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c004].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `spawnWorker; send; kill tmux session directly; wait → reason='dead', finalMessage=''.`
- `checks[c004].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c004].status`: authoring-state field superseded by the derived check box — `open`
- `checks[c005].validates`: v2 test lines have no slot-anchor field — `what`
- `checks[c005].integration_level`: v2 has no verification-surface field — `integration`
- `checks[c005].verification_recipe`: superseded by an audited evidence_path; the full recipe text is preserved here — `spawnWorker({cwd:'/nonexistent-xyz'}); expect WorkerSpawnError.`
- `checks[c005].validates_job`: persona job-story anchor has no v2 equivalent — `developer:1`
- `checks[c005].status`: authoring-state field superseded by the derived check box — `open`
- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `planned`
- `priority`: v2 has no priority enum (FORMAT.md §6) — `high`
- `progress`: v2 recomputes progress from check state on every read; never stored (FORMAT.md §6) — `{"implementation":0,"verification":80}`
- `thumbnail`: v2 has no thumbnail concept; narrative-referenced <svg> media is the only image path — `{"kind":"svg","alt":"Square loop and circle agent joined by a two-way arrow channel — umbel spawn/send bridge","content":"<svg viewBox=\"0 0 120 80\" xmlns=\"http://www.w3.org/2000/svg\"><rect class=\"tc-bg tc-frame\" x=\"8\" y=\"8\" width=\"104\" height=\"64\" rx=\"4\"/><rect class=\"tc-wh tc-frame…(truncated)`
- `parent`: child-feature parent binding is out of scope for this migration pass — `cli-run`
- `journey_phase`: journey-phase concept dropped in v2 per the migration mapping — `build`
- `coverage_files`: v2 has no coverage/code-ownership concept — `["src/adapters/umbel.ts"]`
- `judgments`: v1 slot/coherence judgments have no v2 equivalent — `[{"question_id":"check_discriminates","target":"feature","verdict":"n_a","rationale":"Verdicts are per-check. c002 failed all 3 negctrl strategies; c001/c003/c004/c005 discriminate.","judged_sha":"a049bbbaf6124a454f537406ee94aa33eee4fd07"}]`
- `personas_resolved`: denormalized snapshot; the un-resolved personas[] ids already migrated via ## For — `[{"id":"developer","name":"Developer","jobs":["When I add a capability, because I must not let I/O leak into pure logic or a scheduling decision leak into a seam, we believe the layer boundaries make the wrong place to put code obviously wrong. We'll know we got it right when a change lands in exact…(truncated)`
- `audit.result / audit.verified_at_commit / audit.drift`: v2 never stores an audit block — only the verifier's per-check @sha stamp; per-check pass/fail state is honestly reflected in the migrated check boxes (without shas) per the migration's honesty rule — `result=partial, ran_at=2026-06-16T20:25:00Z`

**Transformation notes:**

- c001: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c002: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c003: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c004: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- c005: audited evidence prose trimmed to its first path token; full audit text remains in the frozen v1 page
- emitted: ## For #developer #operator (from v1 personas)
- emitted: solves inverted into ## Solved by on agent-output-as-truth
- emitted: solves inverted into ## Solved by on logic-io-entanglement
- 2 intra-map v1 link(s) rewritten to .loop.html


## garden (garden)

Source: `docs/tend/overview.html` → `garden.loop.html`

**Dropped fields:**

- `media.overview_arch.alt`: a caption already holds the visible-description slot; the alt text is preserved here — `pleach architecture: tend and umbel as flanking systems, pleach loop in the center with core, seams, and loop layers`
- `dek`: v1's own authored dek is superseded by the derived Goal./Who./Pain. dek (what/why) per the migration mapping; original preserved here — `Operators can't trust stochastic agents to self-certify, and reviewing every diff defeats the point of delegation. pleach is the deterministic conductor between tend and umbel: it isolates each plan node in its own git worktree, enforces gates mechanically, and publishes a node/<id> branch only for …(truncated)`
- `status`: v2 derives state from checks; no status field is stored (FORMAT.md §6) — `planned`
- `progress`: v2 recomputes progress from check state on every read; never stored (FORMAT.md §6) — `{"implementation":0,"verification":0}`
- `catalog`: denormalized project-wide lookup table; equivalent per-entry data already migrated via each catalog-description page — `{"schema_version":"1","project_id":"pleach","status":"approved","journey_phases":["build","verify"],"personas":[{"id":"operator","name":"Operator","archetype":"A practitioner who has already planned work in a tend garden and wants a swarm of stochastic agents to build and verify it unattended — won'…(truncated)`
- `features_aggregate`: denormalized rollup of features; the hub's ## Children is emitted from the migrated set instead — `[{"id":"operator","title":"Operator","status":"planned"},{"id":"developer","title":"Developer","status":"planned"},{"id":"cli-run","title":"pleach run: Execute a Plan","status":"planned","priority":"high","enables":["cli-validate"],"personas":["operator"],"solves":["agent-output-as-truth"],"journey_…(truncated)`
- `health_snapshot`: recomputed by the v2 rail at read time, never stored — `{"verdict":"yellow","reason_codes":["stale_evidence","false_done","blocked","unblocked","unbound_persona"],"truth":{"verified":3,"total":18,"stale":10,"mock_only":0,"false_done":2,"auditable":11,"audited":5},"flow":{"ready_now":5,"blocked":3,"bottleneck_feature_id":"conductor-loop"},"value":{"highes…(truncated)`

**Transformation notes:**

- replaced a literal " · " with " - " (would otherwise split a check/Tried line) in: <svg viewBox="0 0 640 280" xmlns="http://www.w3.org/2000/svg" font-family="ui-mo
- emitted: ## Children (11 loops) from the migrated set
- 10 intra-map v1 link(s) rewritten to .loop.html
