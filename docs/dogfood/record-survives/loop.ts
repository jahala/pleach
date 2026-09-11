import type { Check, LoopSpec } from '../make-plan.ts';

const GROUND = [
  "Ground truth, read before shaping: run-plan.ts settle's done path scans late markers, mints the receipt, calls deps.isolate.commitBranch (src/seams/isolate.ts: git commit -m + git branch -f — hooks RUN) and emitVerdict inside a try; on a throw it sets failure, then disposeOrJournal(iso) runs unconditionally, then a gate-fail line with gate 'commit' and a failed verdict — no receipt, no quarantine (#96). quarantineOrJournal (run-plan.ts) stages changedFiles and calls commitBranch on quarantine/<id> — also hook-bound. The journal is one file, <git-dir>/pleach/journal.jsonl (src/faces/config.ts), append-only through src/seams/journal.ts (envelope applied there, D15); receipts live in <git-dir>/pleach/receipts/<node>.json plus per-close <node>.<prefix>.json (D17) with facts.status and refs; ReceiptStore has write/read/readAt/writeArtifact/discardArtifact. run-plan journals run-start {goal, nodes} and run-end {RunSummary}. Nothing in src reads BLOCKED.md; the work order tells workers to write it at the repo root when genuinely blocked; run-node's ladder after the worker stops goes marker → staging → hygiene → smoke → audit; a retry's re-prompt is withEvidence(prompt, evidence) in run-work.ts. classify: input/idle → blocked (Verdict.status 'blocked', blockedReason = the prompt text). Journal events need docs/journal.md rows and KINDS entries (src/core/journal-envelope.ts; run-level → run.lifecycle, node-level → node.lifecycle). The Plan schema is untouched by this loop.",
].join(' ');

const checks: Check[] = [
  {
    n: 1,
    id: 'rs.snapshot',
    claim:
      '`IsolateSeam.snapshot` records the index and working tree on a branch through `write-tree`, `commit-tree` and `update-ref`, running no hook — proven against a real repository whose pre-commit hook refuses everything; `quarantineOrJournal` uses it, so a quarantine lands where a commit would have been refused',
    evidence: 'test/integration/snapshot-quarantine.test.ts',
    needs: [],
    how: `IsolateSeam (src/loop/deps.ts) gains snapshot(cwd, branch, message): Promise<{sha}> implemented in src/seams/isolate.ts as: git add of the already-staged set is the caller's (quarantine stages changedFiles first, as today); then git write-tree → tree; git commit-tree <tree> -p HEAD -m <message> → sha (no hooks run for write-tree/commit-tree); git update-ref refs/heads/<branch> <sha>. The harness (test/loop/harness.ts) implements snapshot like commitBranch but logs 'snapshot'. run-plan's quarantineOrJournal calls snapshot instead of commitBranch (the busy-branch fallback to .2/.3/.4 stays: update-ref on a branch checked out elsewhere is allowed by git, so the fallback may simplify — keep the behaviour the existing quarantine tests pin). Prove against real git: a tmp repo with core.hooksPath pointing at a pre-commit that exits 1; git commit is refused; snapshot lands the branch with the working tree's content and the message; HEAD is unchanged (detached worktree stays where it was) — or advance HEAD only if the existing quarantine path expects it (read quarantine.test.ts). ${GROUND}`,
  },
  {
    n: 2,
    id: 'rs.commit-refused',
    claim:
      "A verified commit the repository's hook refuses settles the node failed with `gate.ran: 'commit'` and the hook's output as the tail, the tree quarantined by snapshot, the receipt written and naming the quarantine, `node/<id>` absent — nothing disposed before it is kept",
    evidence: 'test/loop/commit-refused.test.ts',
    needs: ['rs.snapshot'],
    how: `In run-plan settle's done path: when commitBranch throws (IsolateCatastrophicError from git commit — the hook's stderr is in its message), do NOT dispose first: build the failed verdict {status 'failed', gate {ran: 'commit', exitCode: -1}} with the hook's output as the tail (gateOutputTail / verdict journal outputTail, capped 2000), re-mint the receipt from the failed facts (the sealed facts must say failed, gate 'commit' with outputTailSha), quarantine by snapshot through quarantineOrJournal, write the receipt with the quarantine refs, THEN dispose. The late-marker GateFailedError path keeps its shape but takes the same keep-then-dispose order. Prove on the harness with a commitBranch that throws (commitBranchBusy is the existing knob — add a commitBranchThrows knob carrying a message): the verdict, the receipt file (facts.status failed, gates include commit with outputTailSha), a quarantine snapshot event, refs.quarantineBranch set, no node/<id> ref, dispose AFTER quarantine in the event log. ${GROUND}`,
  },
  {
    n: 3,
    id: 'rs.journal-gap',
    claim:
      'On `run-start`, every receipt whose node has no `verdict` line in the journal is journaled as `journal-gap` {node, receiptSha256, closedAt}; a complete journal journals none',
    evidence: 'test/loop/journal-gap.test.ts',
    needs: ['rs.commit-refused'],
    how: `Two seam additions, minimal: ReceiptStore.list(): Promise<{node, sha256, closedAt?}[]> over the latest receipts (closedAt from the receipt file's mtime or a receipt facts field if one exists — do not add one to the sealed facts; mtime is honest and unsealed, name it so); JournalSeam.hasVerdict(node): Promise<boolean> (the real seam scans its own file for a verdict line with that node; the harness answers from its array). run-plan, right after run-start: for each listed receipt with no verdict line, journal {event:'journal-gap', node, receiptSha256, closedAt} (KINDS: run.lifecycle; docs row). Prove on the harness: two receipts, one with a verdict line in the journal → exactly one journal-gap; a complete journal → none; the check never fails the run (a list() error is journaled, not thrown). ${GROUND}`,
  },
  {
    n: 4,
    id: 'rs.run-copy',
    claim:
      "At `run-end` the run's own journal lines are copied to `<git-dir>/pleach/receipts/runs/<run-id>.journal.jsonl` and the `run-end` line names the file; the copy holds exactly the run's lines from `run-start` to `run-end`",
    evidence: 'test/integration/run-journal-copy.test.ts',
    needs: ['rs.journal-gap'],
    how: `A run id = the run-start line's time (RFC 3339, filesystem-safe by replacing ':' with '-') — journal it on run-start as runId. JournalSeam gains copyRun(runId, destination-through-the-store): the simplest honest shape is ReceiptStore.writeRunJournal(runId, lines: string[]) and JournalSeam.linesSince(runId) (the real seam re-reads its file from the run-start line carrying that runId to the end; the harness slices its array). run-plan at run-end: append run-end WITH journalCopy: <path> first (so the copy contains it), then copy. Prove against the real seams in a tmp dir: two runs back to back leave two files under receipts/runs/, each holding exactly its own lines from run-start to run-end, and run-end names the path. ${GROUND}`,
  },
  {
    n: 5,
    id: 'rs.blocked-md',
    claim:
      "An attempt whose tree holds `BLOCKED.md` at its root settles the node `blocked` at once with the file's text as `blockedReason`, the tree quarantined and no retry; a retry's re-prompt states that it starts from the prompt alone",
    evidence: 'test/loop/blocked-md.test.ts',
    needs: ['rs.run-copy'],
    how: `IsolateSeam gains readBlocked(cwd): Promise<string | null> (BLOCKED.md at the worktree root, or null; the harness answers from a per-node fixture). In run-node, right after the worker stops (before the marker gate): if readBlocked returns text, hand back {status 'blocked', evidence.blockedReason: the text (capped 4000)} with the live tree — the existing blocked path (D11) quarantines it and no retry happens. partitionDelivery already treats what it treats; BLOCKED.md itself should be set aside from delivery (add it to the never-delivery names) so it never lands in a quarantine as if it were work — or keep it in the quarantine deliberately as the explanation; decide, and say why in Tried (recommendation: keep it in the quarantine — it IS the evidence). In run-work's withEvidence, add one sentence: 'This attempt starts from the prompt and this evidence alone; notes sent to a previous attempt did not survive it.' Prove on the harness: a worker that stops after writing BLOCKED.md yields one attempt, status blocked, blockedReason = the text, a quarantine event; a normal stop is unchanged; the re-prompt text carries the sentence. ${GROUND}`,
  },
  {
    n: 6,
    id: 'rs.docs',
    claim:
      "docs/journal.md documents `journal-gap`, `run-end`'s `journalCopy` and the BLOCKED.md rule; `KINDS` pins the event; README states the three behaviours",
    evidence: 'test/unit/journal-doc.test.ts',
    needs: ['rs.blocked-md'],
    how: `The pin test exists; extend it first with the assertion that makes it red (the run-end row names journalCopy; the blocked row mentions BLOCKED.md), then docs/journal.md rows (journal-gap, run-start's runId, run-end's journalCopy, blocked's BLOCKED.md source), KINDS if a sibling has not, README's landing/quarantine/journal paragraphs; keep test/e2e/help.test.ts green. ${GROUND}`,
  },
  {
    n: 7,
    id: 'rs.e2e',
    claim:
      "Through the real CLI with real git: a repository whose pre-commit hook refuses commits yields a failed node with a snapshot quarantine and a receipt; a deleted journal is reported as gaps on the next run and the previous run's copy exists beside the receipts; a node that writes BLOCKED.md settles blocked in one attempt",
    evidence: 'test/e2e/record-survives.test.ts',
    needs: ['rs.docs'],
    timeoutMs: 2_700_000,
    how: `Model on test/e2e/quarantine.test.ts and teardown.test.ts ({command} nodes, real git). (a) A tmp repo with core.hooksPath=.githooks and a pre-commit that exits 1: run a {command} node that writes a file → exit 1, journal gate-fail commit with the hook's text in the tail, quarantine/<id> holds the file (snapshot), the receipt file exists with facts.status failed, no node/<id>. (b) Run a green plan; delete <git-dir>/pleach/journal.jsonl; run again → the new journal has journal-gap for the earlier node, and receipts/runs/ holds the first run's copy with its run-start and run-end. (c) A node whose command writes BLOCKED.md and exits 0 → one attempt, summary.blocked = [id], blockedReason is the file's text, quarantine holds BLOCKED.md. This node is the sink of the loop: its audit verifies EVERY check on the page; if a sibling's check reads red here, fix it here and say so in Tried. ${GROUND}`,
  },
];

const spec: LoopSpec = {
  loop: 'docs/tend2/record-survives.tend2.html',
  payload: 'e666e66ac130',
  title: 'The record survives what the repository does',
  goal: "A refused commit is a gate verdict like any other: the tree is quarantined by a snapshot no hook can refuse, the receipt carries the hook's own output, and the node settles failed instead of vanishing. The run journal can be lost and still be recovered: a gap between the receipts and the journal is journaled on the next run, and every run leaves a copy of its own lines beside the receipts. A worker that wrote BLOCKED.md has finished and explained: the node settles blocked at once with the file's text, no retry.",
  ledger: 'D21',
  sink: 'rs.e2e',
  checks,
};

export default spec;
