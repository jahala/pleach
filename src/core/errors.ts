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

export class LockHeldError extends Error {
  readonly name = 'LockHeldError';
  readonly path: string;
  readonly pid: number;

  constructor(path: string, pid: number) {
    super(`lock held at ${path} by pid ${pid}`);
    this.path = path;
    this.pid = pid;
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

export type GateKind = 'smoke' | 'marker' | 'red' | 'green' | 'command' | 'setup';

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
