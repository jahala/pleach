export class PlanInvalidError extends Error {
  readonly name = 'PlanInvalidError';
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(reasons.join('; '));
    this.reasons = reasons;
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

  constructor(gate: GateKind, evidence: string) {
    super(`gate '${gate}' failed`);
    this.gate = gate;
    this.evidence = evidence;
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

export class RebuildRequiredError extends Error {
  readonly name = 'RebuildRequiredError';
  readonly nodeId: string;

  constructor(nodeId: string) {
    super(`rebuild required for node '${nodeId}': branch ref not found`);
    this.nodeId = nodeId;
  }
}
