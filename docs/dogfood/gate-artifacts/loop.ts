import type { Check, LoopSpec } from '../make-plan.ts';

const checks: Check[] = [
  {
    n: 1,
    id: 'ga.collect',
    claim:
      "Collection never stages what is not delivery: paths under `.loop-scratch/` or `.plotplot/friction/`, paths git ignores, and paths outside the worktree are set aside before staging (a pure predicate in core plus the seam's ignore check), the journal names what was set aside (`set-aside` {node, paths}), and a finished node with such paths in its touched set closes normally with its tree intact — proven against real git with an ignored scratch file and an absolute path outside the tree",
    evidence: 'test/integration/collect-set-aside.test.ts',
    needs: [],
    timeoutMs: 2_700_000,
    how: `Today run-node builds the staged set as dedup([...result.filesTouched, ...changedFiles]) and hands it to isolate.stage(cwd, files), which runs git add on every path; umbel's manifest can carry an absolute path and a path under .loop-scratch/ (the work order sends scratch there), and git add of an ignored path exits 1, so a FINISHED node dies catastrophically and its tree is disposed (jahala/pleach#74, #79 — forty minutes of an Opus build lost on 2026-09-09; #76 is the un-ignored trap). Two halves. (a) Pure, in core (new src/core/delivery.ts): \`partitionDelivery(paths, cwd)\` → { keep, setAside } that sets aside .loop-scratch/**, .plotplot/friction/**, and any absolute path not under cwd (normalise: absolute paths inside cwd become relative) — total, no I/O. (b) In the seam (src/seams/isolate.ts): \`ignored(cwd, paths): Promise<string[]>\` via \`git check-ignore --no-index\` (batch; exit 1 = none ignored is not an error) — the in-memory harness implements it from a per-node fixture. run-node applies (a) then (b) before stage(), journals {event:'set-aside', node, paths} when anything was set aside, stages what remains, and the node proceeds; nothing about a set-aside path can fail the node. Document \`set-aside\` in docs/journal.md (the journal-doc pin test is red until you do). Prove against REAL git in test/integration (a worktree with .loop-scratch/ ignored, a scratch file the manifest names, an absolute path outside the tree, a friction file): staging succeeds, the commit holds only the delivery, the journal names the rest; and the pure predicate in a unit block in the same file or beside it. This node runs ALONE and lands before its siblings; keep the change minimal and do not touch the smoke/receipt/artifact paths the later checks own.`,
  },
  {
    n: 2,
    id: 'ga.exec-stdout',
    claim:
      "The exec seam reports the child's stdout separately from the interleaved stream (`ExecResult.stdout`, additive), proven against a real process writing to both: `stdout` holds only stdout, `output` still holds both in arrival order, and every existing caller is untouched",
    evidence: 'test/integration/exec-stdout.test.ts',
    needs: ['ga.collect'],
    how: `src/seams/exec.ts already drains stdout and stderr as two streams and concatenates them into \`output\` in arrival order. Add \`stdout: string\` to ExecResult (src/loop/deps.ts) — the child's stdout alone — filled by the real seam from its own stdout drain; \`output\` keeps its meaning and every existing caller keeps working (ExecResult is constructed in a few places — the in-memory harness's execScript in test/loop/harness.ts, guardedExec's guard-hit result in src/loop/run-work.ts, the exec seam's spawn-failure result; give each an honest stdout, '' where there is none). Prove with a real process: a command that writes A to stdout and B to stderr yields stdout === A and output containing both. Model on test/integration/exec.test.ts.`,
  },
  {
    n: 3,
    id: 'ga.parse-sarif',
    claim:
      '`parseSarif` is pure and total: a SARIF 2.1.0 log (version `2.1.0`, `runs[]`) is accepted with its runs, any other JSON, non-JSON, and other SARIF versions are refused, and nothing throws',
    evidence: 'test/unit/sarif.test.ts',
    needs: ['ga.collect'],
    how: `New pure module src/core/sarif.ts (core imports nothing from other layers; zod is available). \`parseSarif(text: string): { version: '2.1.0'; runs: unknown[] } | null\` — null for non-JSON, JSON that is not an object, a missing/other \`version\`, or a non-array \`runs\`. No I/O, no throw. A real SARIF sample is what \`weeder check --strict --format sarif\` prints (the weeder binary at /Users/jahala/.local/bin/weeder can print one for a fixture); keep a small SARIF fixture in test/fixtures/ for the unit test rather than shelling out.`,
  },
  {
    n: 4,
    id: 'ga.artifact-sha',
    claim:
      "When the smoke gate's stdout parses as SARIF the gate record carries `artifactSha` = sha256 of the stdout bytes, `mintReceipt` seals it and `pleach receipt` re-derives it; when it does not, the gate record and the receipt are byte-identical to today",
    evidence: 'test/loop/gate-artifact-receipt.test.ts',
    needs: ['ga.exec-stdout', 'ga.parse-sarif'],
    how: `In src/loop/run-node.ts the smoke gate runs through execGateWithRetry and pushes {gate:'smoke', exitCode}. When the gate's stdout (from ga.exec-stdout) parses with parseSarif (ga.parse-sarif), push {gate:'smoke', exitCode, artifactSha: sha256Hex(stdout)} and carry the stdout bytes on RunNodeResult (e.g. \`smokeStdout?: string\`, journal/settle-only — the Verdict contract is untouched) so settle can write them later; when it does not parse, push exactly what is pushed today. GateRecord (src/core/receipt.ts) gains \`artifactSha?: string\` beside outputTailSha; because canonicalJson drops undefined, every existing receipt hashes exactly as before — assert that in the test. Prove with the in-memory harness (execScript returning a SARIF stdout for the smoke argv vs plain text): the receipt's smoke record has/hasn't artifactSha, mintReceipt's sha256 covers it, and \`pleach receipt\`'s re-derivation (src/loop/receipt-verify.ts) still verifies both.`,
  },
  {
    n: 5,
    id: 'ga.settle-write',
    claim:
      'At settle, before dispose, the kept SARIF is written beside the receipt as `<git-dir>/pleach/receipts/<node>.sarif` with sha256 equal to `gates[].artifactSha`, the receipt file names it outside the envelope (`artifacts.sarif`), the journal carries one `gate-artifact` {node, gate, path, sha256}, docs/journal.md documents the event, docs/contract/CHANGES.md notes the additive receipt field; a write failure journals `receipt-write-failed` and the close stands',
    evidence: 'test/loop/gate-artifact-settle.test.ts',
    needs: ['ga.artifact-sha'],
    how: `ReceiptStore (src/loop/deps.ts, src/seams/receipts.ts) gains \`writeArtifact(node, kind: 'sarif' | 'friction', bytes: string): Promise<string>\` returning the path it wrote (\`<dir>/<node>.sarif\` / \`<dir>/<node>.friction.jsonl\`); the in-memory store in test/loop/harness.ts implements it too. In src/loop/run-plan.ts settle, on BOTH the done path and the quarantine path (a failed smoke that printed SARIF is exactly the log the calibration folds want), after the receipt is minted and before disposeOrJournal: if the outcome carries smoke stdout with an artifactSha, writeArtifact, then journal {event:'gate-artifact', node, gate:'smoke', path, sha256}; the receipt file gets \`artifacts: { sarif?: string }\` OUTSIDE the envelope (a sibling of \`refs\` on the Receipt type — never inside facts). A throw from writeArtifact is caught and journaled as {event:'receipt-write-failed', node, detail} like writeReceiptOrJournal does today, and the close proceeds. Document: docs/journal.md gets the \`gate-artifact\` row (the journal-doc pin test will be red until it does); docs/contract/CHANGES.md gets a dated note that the receipt's GateRecord gained \`artifactSha\` (additive, no schema-block change, no version bump — the plan schema is untouched). Prove on the harness: the artifact write happens before dispose (event order), its sha256 equals the sealed artifactSha, the journal event is right, the receipt file lists the path, and a throwing store yields receipt-write-failed + a normal close.`,
  },
  {
    n: 6,
    id: 'ga.friction',
    claim:
      'A worktree friction journal (`.plotplot/friction/*.jsonl`) is kept as `<node>.friction.jsonl` (months concatenated in name order) with its own `gate-artifact` event',
    evidence: 'test/loop/gate-artifact-friction.test.ts',
    needs: ['ga.settle-write'],
    how: `Two halves. (a) Reading the worktree is seam I/O: IsolateSeam gains \`readFriction(cwd): Promise<string | null>\` (src/loop/deps.ts + src/seams/isolate.ts; the harness implements it from a per-node fixture) that returns the concatenation, in filename order, of every \`.plotplot/friction/*.jsonl\` directly in that directory (not state/, not hotspots.json), or null when the directory or files are absent. At settle (both paths), when it returns text: writeArtifact(node, 'friction', text), journal {event:'gate-artifact', node, gate:'friction', path, sha256: sha256Hex(text)}, receipt \`artifacts.friction\`. (b) is already landed: ga.collect's partitionDelivery sets .plotplot/friction/ aside before staging — read it and do not duplicate it; assert in your test that the friction file is kept AND that it was set aside from the staged set (the journal's set-aside line names it).`,
  },
  {
    n: 7,
    id: 'ga.e2e',
    claim:
      'Through the real CLI with real git and a smoke that prints SARIF to stdout: after a verified close `<git-dir>/pleach/receipts/<node>.sarif` exists, its sha256 equals the sealed `artifactSha`, `pleach receipt <node>` verifies, and a smoke that prints plain text keeps no file',
    evidence: 'test/e2e/gate-artifact.test.ts',
    needs: ['ga.friction'],
    timeoutMs: 2_700_000,
    how: `Model on test/e2e/receipt.test.ts and test/e2e/phases.test.ts (real CLI, real git, the scripted runner or a {command} node — a command node needs no runner at all). The smoke is a fixture script under test/fixtures/ that prints a real SARIF 2.1.0 document to stdout (and, for the negative case, one that prints plain text). Assert: the receipts dir (the same <git-dir>/pleach/receipts/ the receipt verb reads) holds <node>.sarif whose sha256 equals receipt.facts.gates[smoke].artifactSha; \`pleach receipt <node>\` exits 0; the journal has the gate-artifact line; the plain-text run has no .sarif and its receipt has no artifactSha. If weeder is on PATH also run one node whose smoke is \`weeder check --strict\` and assert the same — skip that one case honestly (test.skipIf) when the binary is absent, since CI has none. This node is the sink of the loop: its audit verifies EVERY check on the page; if a sibling's check reads red here, fix it here and say so in Tried.`,
  },
];

const spec: LoopSpec = {
  loop: 'docs/tend2/gate-artifacts.tend2.html',
  payload: 'd796c1bffa1d',
  title: "The smoke gate's SARIF and the worktree's friction journal survive settle",
  goal: "At settle, before the worktree is disposed, pleach keeps two things beside the receipt: the smoke gate's stdout when it parses as SARIF 2.1.0 (<git-dir>/pleach/receipts/<node>.sarif) and the worktree's friction journal when one exists (<git-dir>/pleach/receipts/<node>.friction.jsonl). Inside the sealed envelope, additively, gates[].artifactSha is the sha256 of the kept stdout bytes — one hash, the same the umbrella's receipt predicate (predicate.weeder.sarif.sha256) will cite.",
  ledger: 'D14',
  sink: 'ga.e2e',
  checks,
};

export default spec;
