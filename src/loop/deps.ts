import type { Node, Verdict } from '../core/plan.ts';

// The loop's complete view of the world. Constructed in faces/, injected into
// loop/ — the loop never imports a seam module directly (ENGINEERING.md).

export interface ExecResult {
  output: string;
  exitCode: number;
}

// Arg-array only — never a shell string (ledger SEC1). timeoutMs kills the
// process and resolves with the output gathered so far + a non-zero exitCode.
export type ExecFn = (
  argv: readonly string[],
  opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> },
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
  // Scoped staging — only the given paths, never `git add -A` (ledger S1).
  stage(cwd: string, files: readonly string[]): Promise<void>;
  // The staged diff's text and per-file numstat — the hygiene gate's raw
  // material (§E). Read-only; called after scoped staging.
  stagedDiff(cwd: string): Promise<string>;
  stagedNumstat(cwd: string): Promise<{ file: string; added: number; deleted: number }[]>;
  // Paths (relative) with uncommitted changes — tracked modifications plus
  // untracked-unignored files. The loop's staging fallback when the worker
  // manifest is unavailable; combined with never re-staging at commit time it
  // keeps auditor droppings out of verified commits (ledger S1/C2).
  changedFiles(cwd: string): Promise<string[]>;
  // Commit what is staged and force-point `branch` at the new commit.
  commitBranch(cwd: string, branch: string, message: string): Promise<{ sha: string }>;
  // Resolve a ref to a commit SHA in the repo containing `cwd`; null if the
  // ref does not exist (ledger B1 — the baseRef fallback chain).
  refSha(cwd: string, ref: string): Promise<string | null>;
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
  telemetry: { tokens?: number; contextPct?: number; compacted?: boolean };
}

export interface Worker {
  send(text: string): Promise<void>;
  wait(opts?: { timeoutMs?: number }): Promise<WorkerResult>;
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
}

export interface JournalSeam {
  append(event: Record<string, unknown>): Promise<void>;
}

export interface ConductorDeps {
  exec: ExecFn;
  isolate: IsolateSeam;
  runner: RunnerSeam;
  ledger: LedgerSeam;
  lock: LockSeam;
  journal: JournalSeam;
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
  // Failed nodes whose worktree still held changes: the evidence is committed
  // to quarantine/<id> before dispose (never node/<id> — nothing verified).
  quarantined: string[];
  // Nodes already verified in the ledger before this run — skipped, not re-run.
  // Re-running a plan resumes: only unbuilt or previously-failed nodes execute.
  alreadyVerified: string[];
}
