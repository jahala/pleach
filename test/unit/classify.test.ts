import { describe, expect, test } from 'bun:test';
import type { ClassifyInput } from '../../src/core/classify.ts';
import {
  classify,
  GUARD_REFUSED_EXIT,
  gateFault,
  SPAWN_FAILED_EXIT,
} from '../../src/core/classify.ts';
import {
  AuditParseError,
  GateCannotRunError,
  GateFailedError,
  LockHeldError,
  PlanInvalidError,
} from '../../src/core/errors.ts';

// Helper to make a worker-result input
function workerInput(
  reason: 'dead' | 'timeout' | 'input' | 'idle' | 'stop' | 'aborted',
): ClassifyInput {
  return { kind: 'worker', reason };
}

function errorInput(error: Error): ClassifyInput {
  return { kind: 'error', error };
}

function auditFailInput(failCount: number): ClassifyInput {
  return { kind: 'audit-fail', failCount };
}

describe('classify — worker reasons', () => {
  test('worker reason "dead" → "dead"', () => {
    expect(classify(workerInput('dead'))).toBe('dead');
  });

  test('worker reason "timeout" → "retryable"', () => {
    expect(classify(workerInput('timeout'))).toBe('retryable');
  });

  test('worker reason "input" → "blocked"', () => {
    expect(classify(workerInput('input'))).toBe('blocked');
  });

  test('worker reason "idle" → "blocked"', () => {
    expect(classify(workerInput('idle'))).toBe('blocked');
  });

  test('worker reason "aborted" → "terminal"', () => {
    expect(classify(workerInput('aborted'))).toBe('terminal');
  });

  test('worker reason "stop" (normal completion) — not a classify input scenario; defensive: unknown is terminal', () => {
    // "stop" means the worker finished normally — the loop handles it directly, not via classify.
    // We test that if we somehow pass it, it's terminal (total function, no panic).
    // Actually stop is a valid WorkerResult reason, not passed to classify — but our discriminated union
    // should handle all worker reason values. Let's verify via the 'stop' path.
    expect(classify(workerInput('stop'))).toBe('terminal');
  });
});

describe('classify — errors', () => {
  test('GateFailedError smoke → "retryable"', () => {
    expect(classify(errorInput(new GateFailedError('smoke', 'exit 1', 1)))).toBe('retryable');
  });

  test('GateFailedError marker → "retryable"', () => {
    expect(classify(errorInput(new GateFailedError('marker', 'conflict markers found', -1)))).toBe(
      'retryable',
    );
  });

  test('GateFailedError red → "retryable"', () => {
    expect(classify(errorInput(new GateFailedError('red', '', 0)))).toBe('retryable');
  });

  test('GateFailedError green → "retryable"', () => {
    expect(classify(errorInput(new GateFailedError('green', '', 0)))).toBe('retryable');
  });

  test('GateFailedError command → "retryable"', () => {
    expect(classify(errorInput(new GateFailedError('command', '', 1)))).toBe('retryable');
  });

  test('GateFailedError setup → "retryable"', () => {
    expect(classify(errorInput(new GateFailedError('setup', '', 1)))).toBe('retryable');
  });

  // ledger: D19 — a gate that never ran is nothing a retry or a worker can fix.
  test('GateCannotRunError → "terminal", whichever fault it names', () => {
    expect(
      classify(errorInput(new GateCannotRunError('smoke', 'refused', GUARD_REFUSED_EXIT, 'plan'))),
    ).toBe('terminal');
    expect(
      classify(
        errorInput(new GateCannotRunError('setup', 'ENOENT', SPAWN_FAILED_EXIT, 'environment')),
      ),
    ).toBe('terminal');
  });

  test('AuditParseError → "reaudit"', () => {
    expect(classify(errorInput(new AuditParseError('garbage')))).toBe('reaudit');
  });

  test('LockHeldError → "terminal"', () => {
    expect(classify(errorInput(new LockHeldError('/tmp/x', 42, 'run')))).toBe('terminal');
  });

  test('PlanInvalidError → "terminal"', () => {
    expect(classify(errorInput(new PlanInvalidError(['bad'])))).toBe('terminal');
  });

  test('unknown error → "terminal"', () => {
    expect(classify(errorInput(new Error('something weird')))).toBe('terminal');
  });

  test('non-Error thrown value → "terminal"', () => {
    expect(classify({ kind: 'error', error: new TypeError('unexpected') })).toBe('terminal');
  });
});

// ledger: D19 — whose fault a gate's exit code names when no command ran: the
// no-shell guard's refusal is the plan's, a spawn that never happened is the
// environment's, and every exit a command could have produced is the work's.
describe('gateFault — a gate that never ran', () => {
  test('the guard refusal (-1) is the plan’s fault', () => {
    expect(GUARD_REFUSED_EXIT).toBe(-1);
    expect(gateFault(GUARD_REFUSED_EXIT)).toBe('plan');
  });

  test('a spawn failure (127) is the environment’s fault', () => {
    expect(SPAWN_FAILED_EXIT).toBe(127);
    expect(gateFault(SPAWN_FAILED_EXIT)).toBe('environment');
  });

  test('any other exit ran a command: no fault, the work’s red (or green)', () => {
    for (const code of [0, 1, 2, 126, 128, 137, 255, -2]) expect(gateFault(code)).toBeNull();
  });
});

describe('classify — audit-fail verdicts', () => {
  test('audit-fail with 1 failing verdict → "retryable"', () => {
    expect(classify(auditFailInput(1))).toBe('retryable');
  });

  test('audit-fail with many failing verdicts → "retryable"', () => {
    expect(classify(auditFailInput(5))).toBe('retryable');
  });
});
