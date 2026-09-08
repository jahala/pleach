import type { Check, LoopSpec } from '../make-plan.ts';

const checks: Check[] = [
  {
    n: 1,
    id: 'tpc.seal',
    claim:
      'A phased node seals the red phase as its own commit the moment the RED gate passes and before the impl prompt is sent: scoped-staged red files, subject `pleach: <id> red phase`, trailer `pleach-phase: red`; journal `phase-commit` {node, phase, sha, files}; the settle commit stacks on it',
    evidence: 'test/loop/phase-commit.test.ts',
    needs: [],
    timeoutMs: 2_700_000,
    how: `Where it lives (from the loop's How): runWork (src/loop/run-work.ts) drives the phases; runNode (src/loop/run-node.ts) gives it a seal function through RunWorkOpts and runWork calls it exactly once, after the RED gate passes and before the impl phase's prompt is sent. The seal does what settle's close does in miniature: scoped staging of the red phase's files (result.filesTouched ∪ isolate.changedFiles), then a commit on the detached HEAD. The IsolateSeam (src/loop/deps.ts + src/seams/isolate.ts) has commitBranch(cwd, branch, message) which force-points a branch — a red seal must NOT move any branch, so add a seam method \`commit(cwd, message): Promise<{ sha: string }>\` (no --allow-empty; the empty case is a later check) and implement it for both the real seam (src/seams/isolate.ts, test it in test/integration against real git alongside commitBranch's tests) and the in-memory harness (test/loop/harness.ts — extend InMemoryGit so a loop test can observe the commit's message, sha and the order of events: red gate exec → seal → impl send). Commit message: subject \`pleach: <id> red phase\`, body naming the test command, trailer line \`pleach-phase: red\`. After the seal, journal {event:'phase-commit', node, phase:'red', sha, files}. The RED evidence for the seal's files is the files staged; after the seal, the later scoped staging at close naturally stages only what changed since (HEAD moved). Record the seal in the receipt's gate ladder as {gate:'red', exitCode:0} only if that keeps every existing receipt test green — otherwise leave gates untouched and say so in your Tried line. Do not touch retry/resume semantics, empty-red handling, hygiene/marker gating of the seal, validate, or docs/journal.md — sibling nodes own those; keep your change minimal and leave clear seams for them.`,
  },
  {
    n: 3,
    id: 'tpc.empty',
    claim:
      'A red phase that changes no file fails the `red` gate with evidence naming the empty phase — no seal, retryable like any gate',
    evidence: 'test/loop/phase-commit-empty.test.ts',
    needs: ['tpc.seal'],
    how: `Build on the seal that tpc.seal landed (read its code first: the seal function in run-node.ts and its call in run-work.ts). When the RED gate passes but the red phase's file set (filesTouched ∪ changedFiles) is empty, throw GateFailedError('red', <evidence text naming that the red phase changed no file — a failing test command with no test written is a harness error, not a red>, exitCode) so the existing handleGate → settleRetryable path retries with evidence; no commit is made. Prove with the in-memory harness: a worker whose red phase touches nothing while the test command exits non-zero yields no phase-commit event, no commit, a gate-fail on 'red', and a re-prompt carrying the evidence (maxAttempts 2).`,
  },
  {
    n: 5,
    id: 'tpc.hygiene',
    claim:
      'The seal is gated like the close: conflict markers or a secret in the red files fail `marker` / `hygiene:secret` with no commit made',
    evidence: 'test/loop/phase-commit-hygiene.test.ts',
    needs: ['tpc.empty'],
    how: `Build on the seal as it now stands. Before the seal commits, run the same two scans the close runs in run-node.ts: isolate.scanMarkers(cwd) (markers → GateFailedError('marker', …)) and core/hygiene.ts checkDiffHygiene over the staged red diff with workKind 'phases' (a hygiene hit → GateFailedError('hygiene:<kind>', evidence)). Both flow through the existing gate-failure path (retry with evidence, no commit). Reuse the close's code — extract a shared helper inside run-node.ts if that avoids duplicating the ladder, but keep the close's own behaviour and gate records byte-identical (every existing test stays green). The harness already supports markersByNode and stagedDiffByNode; prove: markers in the red files → no phase-commit, gate 'marker'; a secret-shaped string in the red diff → no phase-commit, gate 'hygiene:secret'; a clean red → sealed as before.`,
  },
  {
    n: 4,
    id: 'tpc.retry',
    claim:
      'A retry after a sealed red resumes at the impl phase carrying the evidence — no second red prompt, no second seal; a red-gate failure before any seal restarts at red',
    evidence: 'test/loop/phase-commit-retry.test.ts',
    needs: ['tpc.hygiene'],
    how: `Build on the seal as it now stands. runNode's attempt loop reuses the tree on a retryable failure (green gate red, smoke red, hygiene …). Track per-tree whether the red seal has happened (reset when the tree is re-isolated, i.e. dead+resume) and pass that into runWork so a retry skips every phase up to and including 'red' and sends the evidence with the first phase it does run (impl). A red-gate failure (RED must FAIL) happens before any seal, so the next attempt starts at red exactly as today. Prove with the harness: (a) green fails on attempt 1 → attempt 2's first prompt is the impl prompt carrying the evidence, exactly one phase-commit event and one red commit across the run; (b) red gate fails on attempt 1 → attempt 2 starts with the red prompt; (c) dead+resume re-isolates → the fresh tree gets a fresh red phase and seal.`,
  },
  {
    n: 2,
    id: 'tpc.e2e',
    claim:
      "Through the real CLI with real git: `node/<id>` history is base → red → verified; the red commit's tree holds the test and the unchanged seed; the verified commit's parent is the red commit and its tree passes the test",
    evidence: 'test/e2e/phase-commit.test.ts',
    needs: ['tpc.retry'],
    how: `Model on test/e2e/phases.test.ts (real CLI, real git, the scripted runner in test/fixtures/phases-scripted.config.ts — read both first; extend the scripted runner only if the existing HONEST script cannot express what you need, and keep phases.test.ts green). Prove on node/calc after an honest run: \`git log\` shows exactly two commits above the seed; the first has subject \`pleach: calc red phase\` and the trailer \`pleach-phase: red\`, its tree has calc.test.ts and calc.ts identical to the seed; the tip's parent is that red commit, its tree passes \`bun test calc.test.ts\`, and its message carries the receipt-sha256 trailer as before. Also assert the journal (<git-dir>/pleach/journal.jsonl) has one phase-commit event for calc whose sha is the red commit. If anything about the real seam disagrees with the loop tests (this is the first real-git proof of the seal), fix the seam — that is the point of this check.`,
  },
  {
    n: 6,
    id: 'tpc.validate',
    claim:
      '`pleach validate` warns on a node whose phases end on impl: `warnings[]` in the JSON, one stderr line, exit stays 0',
    evidence: 'test/unit/validate-phases.test.ts',
    needs: [],
    how: `Independent of the seal work. src/core/validate.ts is pure: add a warnings surface (e.g. validatePlan returns, or a sibling pure function planWarnings(plan) returns, string[]) that names every node whose last phase is 'impl' ("node '<id>': phases end on impl — the green gate never runs, the combined tree is never proven"). The validate verb in src/faces/cli.ts prints the JSON summary today ({valid, order, waves, nodes}); add \`warnings\` (always present, [] when none) and one stderr line per warning; exit code unchanged (0). Keep the drift test and every existing validate test green; do not change the schema. Unit-test the pure function and the CLI output shape (test/unit has cli-summary.test.ts and validate.test.ts to model on).`,
  },
  {
    n: 7,
    id: 'tpc.journal-doc',
    claim:
      'docs/journal.md documents `phase-commit`, and every event name the source appends is documented there (the stability promise, pinned)',
    evidence: 'test/unit/journal-doc.test.ts',
    needs: ['tpc.e2e', 'tpc.validate'],
    how: `Two things. (1) docs/journal.md: add the \`phase-commit\` row (fields: node, phase ('red'), sha, files — the red phase sealed as its own commit before impl, D13) in the events table, matching the table's voice. (2) A unit test that reads docs/journal.md's events table and the source (src/loop/*.ts, src/seams/*.ts, src/faces/*.ts) and asserts every \`event: '<name>'\` literal appended anywhere in src is documented, and every documented event name appears in src — pin the promise both ways. Find event literals with a real scan of the source text (a regex over \`event: '…'\` / \`event: "…"\`), not a hand-kept list. This node is the sink of the whole loop: its audit verifies EVERY check on the page, so if a sibling's check reads red here, fix it here and say so in Tried.`,
  },
];

const spec: LoopSpec = {
  loop: 'docs/tend2/test-phase-commit.tend2.html',
  payload: '5ae23d02010d',
  title: 'The red phase is its own commit',
  goal: "When a node's work carries a test phase ({test, phases}), pleach seals the red phase as its own commit the moment the RED gate passes — before the impl prompt is sent — so the failing-test state exists in node/<id> history: base → red → verified. The GREEN gate runs against the combined tree; the verified commit stacks on the red one.",
  ledger: 'D13',
  sink: 'tpc.journal-doc',
  checks,
};

export default spec;
