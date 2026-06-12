import { AuditParseError, GateFailedError, LockHeldError, PlanInvalidError } from './errors.ts';

export type WorkerReason = 'dead' | 'timeout' | 'input' | 'idle' | 'stop' | 'aborted';

export type ClassifyInput =
  | { kind: 'worker'; reason: WorkerReason }
  | { kind: 'error'; error: Error }
  | { kind: 'audit-fail'; failCount: number };

export type ClassifyResult = 'dead' | 'retryable' | 'blocked' | 'reaudit' | 'terminal';

export function classify(input: ClassifyInput): ClassifyResult {
  switch (input.kind) {
    case 'worker':
      return classifyWorkerReason(input.reason);
    case 'error':
      return classifyError(input.error);
    case 'audit-fail':
      return 'retryable';
  }
}

function classifyWorkerReason(reason: WorkerReason): ClassifyResult {
  switch (reason) {
    case 'dead':
      return 'dead';
    case 'timeout':
      return 'retryable';
    case 'input':
    case 'idle':
      return 'blocked';
    case 'aborted':
      return 'terminal';
    default:
      // 'stop' and any future unknown reasons → terminal
      return 'terminal';
  }
}

function classifyError(error: Error): ClassifyResult {
  if (error instanceof GateFailedError) return 'retryable';
  if (error instanceof AuditParseError) return 'reaudit';
  if (error instanceof LockHeldError) return 'terminal';
  if (error instanceof PlanInvalidError) return 'terminal';
  // unknown error → terminal (never default-retry what we can't name)
  return 'terminal';
}
