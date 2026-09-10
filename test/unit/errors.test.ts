import { describe, expect, test } from 'bun:test';
import {
  AuditParseError,
  GateFailedError,
  IsolateCatastrophicError,
  LockHeldError,
  PlanInvalidError,
  RebuildRequiredError,
  TendTransportError,
  WorkerSeamError,
  WorkerSpawnError,
} from '../../src/core/errors.ts';

describe('PlanInvalidError', () => {
  test('instanceof + fields', () => {
    const e = new PlanInvalidError(['dup id: foo', 'unknown need: bar']);
    expect(e).toBeInstanceOf(PlanInvalidError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('PlanInvalidError');
    expect(e.reasons).toEqual(['dup id: foo', 'unknown need: bar']);
    expect(e.message).toContain('dup id: foo');
  });
});

describe('LockHeldError', () => {
  test('instanceof + fields', () => {
    const e = new LockHeldError('/tmp/pleach.lock', 1234, 'run');
    expect(e).toBeInstanceOf(LockHeldError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('LockHeldError');
    expect(e.path).toBe('/tmp/pleach.lock');
    expect(e.pid).toBe(1234);
    expect(e.lock).toBe('run');
    // D18: which lock and whose pid — what the face prints at exit 3.
    expect(new LockHeldError('/tmp/pleach.lock.land', 7, 'land').message).toContain(
      'land lock held by pid 7',
    );
  });
});

describe('IsolateCatastrophicError', () => {
  test('instanceof + fields', () => {
    const e = new IsolateCatastrophicError('node/foo', 'merge failed catastrophically');
    expect(e).toBeInstanceOf(IsolateCatastrophicError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('IsolateCatastrophicError');
    expect(e.ref).toBe('node/foo');
    expect(e.detail).toBe('merge failed catastrophically');
  });
});

describe('GateFailedError', () => {
  test('instanceof + fields — smoke gate', () => {
    const e = new GateFailedError('smoke', 'exit 1\nsome output', 1);
    expect(e).toBeInstanceOf(GateFailedError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('GateFailedError');
    expect(e.gate).toBe('smoke');
    expect(e.evidence).toBe('exit 1\nsome output');
    expect(e.exitCode).toBe(1);
  });

  test('all valid gate values accepted', () => {
    const gates = ['smoke', 'marker', 'red', 'green', 'command', 'setup'] as const;
    for (const gate of gates) {
      const e = new GateFailedError(gate, 'evidence', 0);
      expect(e.gate).toBe(gate);
    }
  });
});

describe('AuditParseError', () => {
  test('instanceof + fields', () => {
    const e = new AuditParseError('not valid json');
    expect(e).toBeInstanceOf(AuditParseError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('AuditParseError');
    expect(e.raw).toBe('not valid json');
  });
});

describe('WorkerSpawnError', () => {
  test('instanceof + fields', () => {
    const e = new WorkerSpawnError('umbel spawn exited 1');
    expect(e).toBeInstanceOf(WorkerSpawnError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('WorkerSpawnError');
    expect(e.detail).toBe('umbel spawn exited 1');
  });
});

describe('WorkerSeamError', () => {
  test('instanceof + fields', () => {
    const e = new WorkerSeamError('send subprocess exited 1: error output');
    expect(e).toBeInstanceOf(WorkerSeamError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('WorkerSeamError');
    expect(e.detail).toBe('send subprocess exited 1: error output');
    expect(e.message).toContain('send subprocess exited 1: error output');
  });
});

describe('RebuildRequiredError', () => {
  test('instanceof + fields', () => {
    const e = new RebuildRequiredError('step-3');
    expect(e).toBeInstanceOf(RebuildRequiredError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('RebuildRequiredError');
    expect(e.nodeId).toBe('step-3');
  });
});

describe('TendTransportError', () => {
  test('instanceof + fields', () => {
    const e = new TendTransportError('/path/to/ingester.ts', 'missing export readClosed');
    expect(e).toBeInstanceOf(TendTransportError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('TendTransportError');
    expect(e.modulePath).toBe('/path/to/ingester.ts');
    expect(e.detail).toBe('missing export readClosed');
    expect(e.message).toContain('/path/to/ingester.ts');
    expect(e.message).toContain('missing export readClosed');
  });
});
