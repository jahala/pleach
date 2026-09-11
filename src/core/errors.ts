import type { GateFault } from './classify.ts';
import type { HygieneFailure } from './hygiene.ts';

export class PlanInvalidError extends Error {
  readonly name = 'PlanInvalidError';
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(reasons.join('; '));
    this.reasons = reasons;
  }
}

export class ArgvParseError extends Error {
  readonly name = 'ArgvParseError';
  readonly command: string;

  constructor(command: string, detail: string) {
    super(`argv parse error: ${detail}: ${command}`);
    this.command = command;
  }
}

// ledger: D18 — which of the two locks a refusal is about. The run's guards the
// run's own state; the landing's guards the base branch. They are separate
// files and refuse only their own kind, so a refusal that does not say which
// one it is leaves the operator with nothing to act on.
export type LockKind = 'run' | 'land';

export class LockHeldError extends Error {
  readonly name = 'LockHeldError';
  readonly path: string;
  readonly pid: number;
  readonly lock: LockKind;

  constructor(path: string, pid: number, lock: LockKind) {
    super(`${lock} lock held by pid ${pid} at ${path}`);
    this.path = path;
    this.pid = pid;
    this.lock = lock;
  }
}

// ledger: D16 — `pleach stop` found no run to drain: no lockfile for this
// (repoRoot, source), or the pid it names is dead. Nothing is written when this
// throws — a marker no run will ever read is a trap for the next one.
export class NoRunError extends Error {
  readonly name = 'NoRunError';
  readonly source: string;

  constructor(source: string) {
    super(`no run holds the lock for ${source}`);
    this.source = source;
  }
}

export class IsolateCatastrophicError extends Error {
  readonly name = 'IsolateCatastrophicError';
  readonly ref: string;
  readonly detail: string;

  constructor(ref: string, detail: string) {
    super(`catastrophic isolate failure at ref ${ref}: ${detail}`);
    this.ref = ref;
    this.detail = detail;
  }
}

// The hygiene battery names its own kinds; the gate label carries the kind so
// the operator reads one vocabulary wherever the battery runs — the close's
// ladder and the red-phase seal (D13).
export type GateKind =
  | 'smoke'
  | 'marker'
  | 'red'
  | 'green'
  | 'command'
  | 'setup'
  | `hygiene:${HygieneFailure['kind']}`;

export class GateFailedError extends Error {
  readonly name = 'GateFailedError';
  readonly gate: GateKind;
  readonly evidence: string;
  readonly exitCode: number;

  constructor(gate: GateKind, evidence: string, exitCode: number) {
    super(`gate '${gate}' failed`);
    this.gate = gate;
    this.evidence = evidence;
    this.exitCode = exitCode;
  }
}

// ledger: D19 — a gate that never ran a command: the no-shell guard refused
// it, or the exec seam could not spawn it. Distinct from GateFailedError on
// purpose: that one is a red the work can fix and retries; this one names the
// plan or the environment and settles the node on the attempt that found it.
// `output` is what the guard or the seam said — no child ever wrote any.
export class GateCannotRunError extends Error {
  readonly name = 'GateCannotRunError';
  readonly gate: GateKind;
  readonly output: string;
  readonly exitCode: number;
  readonly fault: GateFault;

  constructor(gate: GateKind, output: string, exitCode: number, fault: GateFault) {
    super(`gate '${gate}' cannot run (${fault})`);
    this.gate = gate;
    this.output = output;
    this.exitCode = exitCode;
    this.fault = fault;
  }
}

export class AuditParseError extends Error {
  readonly name = 'AuditParseError';
  readonly raw: string;

  constructor(raw: string) {
    super('failed to parse audit result');
    this.raw = raw;
  }
}

export class WorkerSpawnError extends Error {
  readonly name = 'WorkerSpawnError';
  readonly detail: string;

  constructor(detail: string) {
    super(`worker spawn failed: ${detail}`);
    this.detail = detail;
  }
}

export class WorkerSeamError extends Error {
  readonly name = 'WorkerSeamError';
  readonly detail: string;

  constructor(detail: string) {
    super(`worker seam error: ${detail}`);
    this.detail = detail;
  }
}

export class RebuildRequiredError extends Error {
  readonly name = 'RebuildRequiredError';
  readonly nodeId: string;

  constructor(nodeId: string) {
    super(`rebuild required for node '${nodeId}': branch ref not found`);
    this.nodeId = nodeId;
  }
}

export class TendTransportError extends Error {
  readonly name = 'TendTransportError';
  readonly modulePath: string;
  readonly detail: string;

  constructor(modulePath: string, detail: string) {
    super(`tend transport error at '${modulePath}': ${detail}`);
    this.modulePath = modulePath;
    this.detail = detail;
  }
}

export class LedgerError extends Error {
  readonly name = 'LedgerError';
  readonly detail: string;

  constructor(detail: string) {
    super(`ledger error: ${detail}`);
    this.detail = detail;
  }
}

// Landing hit a real merge conflict between sink branches (ledger B3). The
// landing worktree was disposed; the user's checkout is untouched.
export class LandConflictError extends Error {
  readonly name = 'LandConflictError';
  readonly ref: string;
  readonly files: string[];

  constructor(ref: string, files: string[]) {
    super(`landing ${ref} conflicts in: ${files.join(', ')} — resolve manually (git merge ${ref})`);
    this.ref = ref;
    this.files = files;
  }
}

// Landing cannot proceed — detached HEAD, unverified nodes, or a refused
// fast-forward (branch moved / overlapping uncommitted changes). Nothing was
// modified.
export class LandBlockedError extends Error {
  readonly name = 'LandBlockedError';
  readonly reason: string;

  constructor(reason: string) {
    super(`cannot land: ${reason}`);
    this.reason = reason;
  }
}

// #12 — every quarantine ref for a node is checked out in some worktree, so
// there is nowhere to commit its evidence. Caught by the quarantine path
// itself, which journals it as `quarantine-failed` and never masks the real
// verdict with it.
export class QuarantineBusyError extends Error {
  readonly name = 'QuarantineBusyError';
  readonly branch: string;

  constructor(branch: string) {
    super(`all quarantine refs for ${branch} are busy`);
    this.branch = branch;
  }
}

// ledger: D17 — `pleach audit` was asked to re-adjudicate a node it cannot
// stand behind: no close on file, a close that was never quarantined, a build
// whose own gates went red, or a quarantined tree that is gone or has moved.
// Nothing is written when this throws: a re-audit that cannot name the tree it
// judged would be a verdict about nothing.
export class AuditRefusedError extends Error {
  readonly name = 'AuditRefusedError';
  readonly nodeId: string;
  readonly reason: string;

  constructor(nodeId: string, reason: string) {
    super(`cannot re-audit '${nodeId}': ${reason}`);
    this.nodeId = nodeId;
    this.reason = reason;
  }
}

export class ConfigError extends Error {
  readonly name = 'ConfigError';
  readonly path: string;
  readonly detail: string;

  constructor(path: string, detail: string) {
    super(`config error at '${path}': ${detail}`);
    this.path = path;
    this.detail = detail;
  }
}

// A journal event with no pinned `plotplot.kind` (ledger D15). Unreachable
// while `KINDS` covers every event docs/journal.md documents; a throw rather
// than a default kind precisely because a silent fallback is how a stream
// acquires a fourteenth private kind.
export class JournalEventUnknownError extends Error {
  readonly name = 'JournalEventUnknownError';
  readonly event: string;

  constructor(event: string) {
    super(`no pinned plotplot.kind for journal event '${event}'`);
    this.event = event;
  }
}

// The run's own `run-start` is not in the journal its lines are copied from
// (D21): the file was lost or replaced while the run went on, so no copy can
// hold the run from its start. run-plan journals it, and the run stands.
export class JournalRunMissingError extends Error {
  readonly name = 'JournalRunMissingError';
  readonly path: string;
  readonly runId: string;

  constructor(path: string, runId: string) {
    super(`no run-start for run ${runId} in ${path}: the journal lost this run's start`);
    this.path = path;
    this.runId = runId;
  }
}
