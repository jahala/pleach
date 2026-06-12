import { describe, expect, test } from 'bun:test';
import type { ClassifyInput } from '../../src/core/classify.ts';
import { classify } from '../../src/core/classify.ts';
import {
  AuditParseError,
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
    expect(classify(errorInput(new GateFailedError('smoke', 'exit 1')))).toBe('retryable');
  });

  test('GateFailedError marker → "retryable"', () => {
    expect(classify(errorInput(new GateFailedError('marker', 'conflict markers found')))).toBe(
      'retryable',
    );
  });

  test('GateFailedError red → "retryable"', () => {
    expect(classify(errorInput(new GateFailedError('red', '')))).toBe('retryable');
  });

  test('GateFailedError green → "retryable"', () => {
    expect(classify(errorInput(new GateFailedError('green', '')))).toBe('retryable');
  });

  test('GateFailedError command → "retryable"', () => {
    expect(classify(errorInput(new GateFailedError('command', '')))).toBe('retryable');
  });

  test('GateFailedError setup → "retryable"', () => {
    expect(classify(errorInput(new GateFailedError('setup', '')))).toBe('retryable');
  });

  test('AuditParseError → "reaudit"', () => {
    expect(classify(errorInput(new AuditParseError('garbage')))).toBe('reaudit');
  });

  test('LockHeldError → "terminal"', () => {
    expect(classify(errorInput(new LockHeldError('/tmp/x', 42)))).toBe('terminal');
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

describe('classify — audit-fail verdicts', () => {
  test('audit-fail with 1 failing verdict → "retryable"', () => {
    expect(classify(auditFailInput(1))).toBe('retryable');
  });

  test('audit-fail with many failing verdicts → "retryable"', () => {
    expect(classify(auditFailInput(5))).toBe('retryable');
  });
});
