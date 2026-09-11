import type { Node, Verdict } from '../core/plan.ts';
import type { Receipt } from '../core/receipt.ts';

// The loop's complete view of the world. Constructed in faces/, injected into
// loop/ — the loop never imports a seam module directly (ENGINEERING.md).

export interface ExecResult {
  // Both streams, interleaved in arrival order.
  output: string;
  // The child's stdout alone. A findings log a gate writes to stdout is only
  // parseable with stderr's noise out of the way (ledger D14).
  stdout: string;
  exitCode: number;
}

// Arg-array only — never a shell string (ledger SEC1). timeoutMs kills the
// process and resolves with the output gathered so far + a non-zero exitCode.
export type ExecFn = (
  argv: readonly string[],
  opts: { cwd: string; timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal },
) => Promise<ExecResult>;

export interface Isolation {
  cwd: string;
  // Files left with conflict markers by the dep merges — fed into the node's
  // prompt so the worker knows the integration work it owes (ledger B3/C1).
  conflictFiles: string[];
  dispose: () => Promise<void>;
}

// A built-but-unpublished land stack: every sink merged in a throwaway
// worktree at the target branch's tip. The loop gates in `cwd`, then either
// publishes (ff-only) or disposes without a trace. Gate commands MAY write to
// the worktree (a verifier stamping its own page is by design — never assert
// a clean tree after a gate).
export interface LandStack {
  cwd: string;
  // The target branch's tip as it was BEFORE these merges — the one fact an
  // operator's land gate cannot know from inside the stack (D18: `{base}`).
  baseSha: string;
  publish(): Promise<{ branch: string; sha: string }>;
  dispose(): Promise<void>;
}

export interface IsolateSeam {
  // Detached worktree at baseRefs[0] with the rest merged in. Normal conflicts
  // are KEPT (markers + conflictFiles); a catastrophic merge (bad ref,
  // unrelated histories) self-cleans and throws IsolateCatastrophicError.
  isolate(node: Node, baseRefs: readonly string[]): Promise<Isolation>;
  // Paths (relative to cwd) of tracked-or-staged files containing conflict
  // markers. Empty array = the marker gate passes (ledger C1).
  scanMarkers(cwd: string): Promise<string[]>;
  // Which of `paths` this worktree's git ignores, verbatim as given. The other
  // half of collection (ledger D14): `git add` of an ignored path exits 1 and
  // killed FINISHED nodes (#74/#76), so ignored paths are set aside before
  // staging. Paths are worktree-relative — partitionDelivery has already
  // removed anything outside the tree. Nothing ignored is an answer, not an
  // error.
  ignored(cwd: string, paths: readonly string[]): Promise<string[]>;
  // The worktree's friction journal, or null when there is none (D14). The
  // month files weeder/tend2 write directly in `.plotplot/friction/`
  // (`<yyyy-mm>.jsonl` — never the ledger's own `state/` or `hotspots.json`),
  // concatenated in filename order. Never delivery (partitionDelivery sets the
  // directory aside), so settle keeps it beside the receipt before the tree
  // goes — the last moment it can be read at all.
  readFriction(cwd: string): Promise<string | null>;
  // Scoped staging — only the given paths, never `git add -A` (ledger S1).
  stage(cwd: string, files: readonly string[]): Promise<void>;
  // The staged diff's text and per-file numstat — the hygiene gate's raw
  // material (§E). Read-only; called after scoped staging.
  stagedDiff(cwd: string): Promise<string>;
  stagedNumstat(cwd: string): Promise<{ file: string; added: number; deleted: number }[]>;
  // The paths the index holds against HEAD after staging (D19) — what the
  // close will commit, which is not always what staging was handed: a path a
  // worker names but never changed stages nothing. The receipt counts this.
  stagedPaths(cwd: string): Promise<string[]>;
  // Paths (relative) with uncommitted changes — tracked modifications plus
  // untracked-unignored files. The loop's staging fallback when the worker
  // manifest is unavailable; combined with never re-staging at commit time it
  // keeps auditor droppings out of verified commits (ledger S1/C2).
  changedFiles(cwd: string): Promise<string[]>;
  // Commit what is staged on the detached HEAD, moving NO branch — the phase
  // seal (D13). The red state must exist in history before impl is prompted,
  // but nothing is published before settle, so the close's commit stacks on
  // this one. No --allow-empty: a seal over nothing is not a red state.
  commit(cwd: string, message: string): Promise<{ sha: string }>;
  // Commit what is staged and force-point `branch` at the new commit.
  commitBranch(cwd: string, branch: string, message: string): Promise<{ sha: string }>;
  // Keep what is staged on `branch` without committing (D21): the quarantine.
  // No hook runs, so no hook can refuse the evidence of what failed; HEAD does
  // not move. A branch checked out in any worktree is refused like
  // commitBranch refuses it ('used by worktree') — never moved under its owner.
  snapshot(cwd: string, branch: string, message: string): Promise<{ sha: string }>;
  // Resolve a ref to a commit SHA in the repo containing `cwd`; null if the
  // ref does not exist (ledger B1 — the baseRef fallback chain).
  refSha(cwd: string, ref: string): Promise<string | null>;
  // Full commit message (subject + body) of `ref`; null when it doesn't
  // resolve. The receipt verb reads the receipt-sha256 trailer from it (§D).
  commitMessageOf(cwd: string, ref: string): Promise<string | null>;
  // The `--stat` summary of the change `ref` introduced; null when the ref
  // doesn't resolve or introduced nothing. A resumed node's first prompt names
  // what the interrupted attempt was holding when its tree was quarantined
  // (D17) — the worker is about to continue inside that work.
  commitStat(cwd: string, ref: string): Promise<string | null>;
  // Land verified refs onto the branch checked out in repoRoot (ledger B3).
  // Builds the merges in a throwaway detached worktree; the checkout is only
  // ever touched by a final `merge --ff-only`, so a conflict (LandConflictError),
  // a detached HEAD, or a refused fast-forward (LandBlockedError) leaves the
  // repo exactly as it was.
  // Staged landing: build the sink-merge stack in a throwaway worktree,
  // hand the loop its cwd for the land gate, publish only on explicit call
  // (ff-only, the sole touch on the checkout). Adoption ladder §A.
  landStack(repoRoot: string, refs: readonly string[]): Promise<LandStack>;
}

export interface WorkerResult {
  // Read UNTRUNCATED — audit-result egress depends on it (ledger C4).
  finalMessage: string;
  actions?: unknown;
  diff?: string;
  filesTouched: string[];
  exitCode?: number;
  reason?: 'stop' | 'dead' | 'timeout' | 'aborted' | 'input' | 'idle';
  // The blocking prompt text when reason is input/idle — the loop carries it
  // into Verdict.evidence.blockedReason (contract v1.1.1).
  message?: string;
  // What the runner saw when the session ended abnormally (D11): the last pane
  // capture and the process exit code, when the runner can supply them. Filled
  // by adapters whose backend persists them (umbel's pane-capture-at-death);
  // absent otherwise — never fabricated. Journal-only diagnostics.
  paneTail?: string;
  processExit?: number;
  telemetry: { tokens?: number; contextPct?: number; compacted?: boolean };
}

export interface Worker {
  send(text: string): Promise<void>;
  // signal (D12): the conductor is tearing down — end the wait promptly (the
  // session is killed by the caller as usual; only the WAIT is interrupted).
  // idleMs (D16): end the wait when the worker has been quiet that long — the
  // conductor's idle policy, passed down so a wedged worker (an auditor idle
  // on a 404) ends here instead of riding the attempt clock with the operator
  // as the idle detector. A runner that cannot detect idleness ignores it and
  // the attempt clock still bounds the wait.
  wait(opts?: { timeoutMs?: number; signal?: AbortSignal; idleMs?: number }): Promise<WorkerResult>;
  kill(): Promise<void>;
}

export interface RunnerSeam {
  spawnWorker(spec: { provider?: string; model?: string; cwd: string }): Promise<Worker>;
}

export interface LedgerSeam {
  // id → verified commit SHA; null when tend has no SHA recorded (legacy /
  // out-of-band verification). The SHA is the durable resume base (ledger B1).
  readClosed(source: string): Promise<Map<string, string | null>>;
  emitVerdict(v: Verdict, source: string): Promise<{ closed: boolean }>;
}

export interface LockHandle {
  release(): Promise<void>;
}

export interface LockSeam {
  // O_EXCL pid lockfile per (repoRoot, source). Throws LockHeldError when a
  // live process holds it; takes over a stale lock (ledger B4).
  acquire(repoRoot: string, source: string): Promise<LockHandle>;
  // The landing's own lock, beside the run's (ledger D18). A landing writes
  // the base branch and a run writes its own state — they never write the same
  // thing, so a landing must not queue behind the run's lock: a settled node
  // lands while the run is still gating the others. Only another landing
  // refuses it, and the refusal names which lock and whose pid.
  acquireLand(repoRoot: string, source: string): Promise<LockHandle>;
  // Is a drain outstanding for this run (ledger D16)? The stop marker lives
  // beside the lock because that is where the (repoRoot, source) path is
  // known. It is a marker and not a signal because a signal cannot be made
  // race-free against a scheduler that launches in the same tick as a close:
  // the scheduler asks this as part of every launch decision, so a stop
  // written at any moment is seen by the very next launch. Presence is the
  // whole request — there is nothing else to read.
  stopRequested(repoRoot: string, source: string): Promise<boolean>;
  // Consume the marker, so the run that drained does not leave the next one
  // stopped before it starts. Nothing to consume is an answer, not a failure.
  clearStop(repoRoot: string, source: string): Promise<void>;
}

export interface JournalSeam {
  append(event: Record<string, unknown>): Promise<void>;
  // The nodes this journal holds a `verdict` line for, read in one pass — the
  // receipts' witness at run-start (D21). No journal holds none.
  verdictNodes(): Promise<Set<string>>;
  // The lines from the `run-start` carrying `runId` to the end, verbatim as
  // the journal holds them — the run's own copy at run-end (D21). A journal
  // that no longer holds that run-start throws JournalRunMissingError.
  linesSince(runId: string): Promise<string[]>;
}

// A node's latest close as the store holds it (D21). `closedAt` is when the
// store last wrote that file, its modification time: honest, but not sealed —
// no receipt fact records when a close happened.
export interface ReceiptListing {
  node: string;
  sha256: string;
  closedAt: string;
}

// The receipt store (§D): one JSON file per node under
// <git-dir>/pleach/receipts/. read() returns null for missing OR unreadable —
// the callers' honest degradations (no invalidation without a record; the
// receipt verb reports UNDERIVABLE).
// What can be kept beside a receipt: a gate's findings log, the worktree's
// friction journal (D14), or the message the worker handed the work back with
// (D17). The store owns the filenames — a caller asks for a kind and is told
// where the bytes went.
export type ArtifactKind = 'sarif' | 'friction' | 'handback';

export interface ReceiptStore {
  // Keeps the close under its own hash AND as the node's latest (D17): a node
  // id runs again and the second close must not erase the first.
  write(node: string, receipt: Receipt): Promise<void>;
  // The node's latest close.
  read(node: string): Promise<Receipt | null>;
  // One named close — how `previousReceiptSha256` is followed back through a
  // node's history. Missing or unreadable is null, exactly like read().
  readAt(node: string, receiptSha256: string): Promise<Receipt | null>;
  // Every node's latest close, whatever plan wrote it, in node order. An
  // unreadable file is no record, exactly like read(); a store that cannot be
  // listed throws.
  list(): Promise<ReceiptListing[]>;
  // The receipt this artifact belongs to, so the store can keep it under that
  // close's own name. Returns the path it wrote — what the journal records and
  // the receipt file names. Write errors propagate; run-plan owns the
  // never-fail-a-close rule.
  writeArtifact(
    node: string,
    kind: ArtifactKind,
    bytes: string,
    receiptSha256: string,
  ): Promise<string>;
  // Forget this close's artifact of this kind, and the node's latest copy of it
  // — never an earlier close's, which its own receipt seals. Nothing to forget
  // is an answer, not a failure; other errors propagate like writeArtifact's.
  discardArtifact(node: string, kind: ArtifactKind, receiptSha256: string): Promise<void>;
  // Where a run's copy of its own journal lines is kept (D21): known before
  // the lines are, because the `run-end` line names it and is its last line.
  runJournalPath(runId: string): string;
  // Keep the run's lines, one per line, at runJournalPath(runId). Write errors
  // propagate; run-plan owns the never-fail-a-run rule.
  writeRunJournal(runId: string, lines: readonly string[]): Promise<void>;
}

export interface ConductorDeps {
  exec: ExecFn;
  isolate: IsolateSeam;
  runner: RunnerSeam;
  ledger: LedgerSeam;
  lock: LockSeam;
  journal: JournalSeam;
  receipts: ReceiptStore;
}

export interface RunSummary {
  closed: string[];
  failed: string[];
  // Nodes that ran to a 'done' verdict — work committed to node/<id>, every
  // conductor gate (build, smoke, cross-provider audit) green — but tend's
  // emitVerdict declined to verify-close (e.g. a check lacked a discriminating
  // negative control). The branch is published; the node is NOT failed (nothing
  // broke) and NOT closed (not verified). Dependents are skipped. A caller must
  // not retry these as failures — the build is already good.
  partial: string[];
  skipped: string[];
  // Nodes whose worker settled at a permission prompt (Verdict status
  // 'blocked'). The session is terminated and the prompt text recorded as
  // blockedReason — fix the permission mode / allowlist and re-run.
  blocked: string[];
  // Nodes the run's own signal interrupted mid-wait (Verdict status 'aborted',
  // D16). They did not fail — the run stopped holding them: the receipt is
  // written and the tree quarantined as it stands, so a re-run rebuilds from
  // evidence rather than from nothing. Not clean, but not a defeat either.
  aborted: string[];
  // Failed, blocked or aborted nodes whose worktree still held changes: the
  // evidence is committed to quarantine/<id> before dispose (never node/<id> —
  // nothing verified). Unfinished work is not wrong — it is worth keeping (D11).
  quarantined: string[];
  // Nodes already verified in the ledger before this run — skipped, not re-run.
  // Re-running a plan resumes: only unbuilt or previously-failed nodes execute.
  alreadyVerified: string[];
}
