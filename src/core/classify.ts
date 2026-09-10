import {
  AuditParseError,
  GateCannotRunError,
  GateFailedError,
  LockHeldError,
  PlanInvalidError,
} from './errors.ts';

// The two exits a gate reports when its command could not run at all (ledger
// D19): the no-shell guard refused the string before exec, or the exec seam
// could not spawn it (a missing binary, a cwd that is not there). 127 is the
// shell's command-not-found convention, so a wrapping shell that could not
// find its command reads the same — and is the environment's fault the same
// way. Their producers use these; gateFault reads them.
export const GUARD_REFUSED_EXIT = -1;
export const SPAWN_FAILED_EXIT = 127;

// Whose fault a gate that never ran is: the plan's when it authored a command
// that cannot be exec'd, the environment's when it cannot provide what the
// command names. null for every exit a command could have produced — that is
// the work's red, and retries with evidence as it always has.
export type GateFault = 'plan' | 'environment';

export function gateFault(exitCode: number): GateFault | null {
  if (exitCode === GUARD_REFUSED_EXIT) return 'plan';
  if (exitCode === SPAWN_FAILED_EXIT) return 'environment';
  return null;
}

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
  // A gate that never ran: no retry changes the command or the environment,
  // and no worker can fix either (D19).
  if (error instanceof GateCannotRunError) return 'terminal';
  if (error instanceof GateFailedError) return 'retryable';
  if (error instanceof AuditParseError) return 'reaudit';
  if (error instanceof LockHeldError) return 'terminal';
  if (error instanceof PlanInvalidError) return 'terminal';
  // unknown error → terminal (never default-retry what we can't name)
  return 'terminal';
}
