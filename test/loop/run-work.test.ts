import { describe, expect, test } from 'bun:test';
import { GateFailedError } from '../../src/core/errors.ts';
import type { Node } from '../../src/core/plan.ts';
import type { ExecFn, ExecResult, Worker, WorkerResult } from '../../src/loop/deps.ts';
import { promptFor, runWork } from '../../src/loop/run-work.ts';

// spec: §6 run-work — the three Work shapes and their gates. In-memory Worker
// and scripted ExecFn; the subject is runWork's control flow.

const TIMEOUT = 1000;

// A scripted child speaks on stdout; nothing here writes to stderr.
const said = (output: string, exitCode: number): ExecResult => ({
  output,
  stdout: output,
  exitCode,
});

function node(over: Partial<Node>): Node {
  return {
    id: 'n',
    worker: {},
    work: { prompt: 'do it' },
    needs: [],
    accept: {},
    policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
    closes: [],
    ...over,
  } as Node;
}

function stopResult(over: Partial<WorkerResult> = {}): WorkerResult {
  return { finalMessage: 'done', filesTouched: [], reason: 'stop', telemetry: {}, ...over };
}

// A scripted worker: records sends, returns queued wait results in order.
function scriptedWorker(waits: WorkerResult[]): {
  worker: Worker;
  sends: string[];
  killed: number;
} {
  const sends: string[] = [];
  let killed = 0;
  const queue = [...waits];
  const worker: Worker = {
    async send(text) {
      sends.push(text);
    },
    async wait() {
      const next = queue.shift();
      if (!next) throw new Error('test: wait() called more times than scripted');
      return next;
    },
    async kill() {
      killed += 1;
    },
  };
  return {
    worker,
    sends,
    get killed() {
      return killed;
    },
  };
}

// Scripted exec keyed by the first argv element (the command head).
function scriptedExec(byHead: Record<string, { output: string; exitCode: number }>): {
  exec: ExecFn;
  calls: { argv: readonly string[]; timeoutMs?: number }[];
} {
  const calls: { argv: readonly string[]; timeoutMs?: number }[] = [];
  const exec: ExecFn = async (argv, opts) => {
    calls.push({ argv, timeoutMs: opts.timeoutMs });
    const head = argv[0] ?? '';
    const r = byHead[head];
    if (!r) throw new Error(`test: no scripted exec for head '${head}'`);
    return { ...r, stdout: r.output };
  };
  return { exec, calls };
}

describe('runWork — {prompt}', () => {
  test('sends the prompt once and returns the wait result', async () => {
    const n = node({ work: { prompt: 'build the thing' } });
    const w = scriptedWorker([stopResult({ finalMessage: 'built' })]);
    const { exec } = scriptedExec({});
    const result = await runWork(n, w.worker, exec, '/wt', { timeoutMs: TIMEOUT });
    expect(w.sends).toEqual(['build the thing']);
    expect(result.finalMessage).toBe('built');
    expect(result.reason).toBe('stop');
  });

  test('a non-stop wait short-circuits and returns that result', async () => {
    const n = node({ work: { prompt: 'p' } });
    const w = scriptedWorker([stopResult({ reason: 'input', message: 'permission?' })]);
    const { exec } = scriptedExec({});
    const result = await runWork(n, w.worker, exec, '/wt', { timeoutMs: TIMEOUT });
    expect(result.reason).toBe('input');
    expect(result.message).toBe('permission?');
  });
});

describe('runWork — {test, phases}: RED/GREEN exec gates', () => {
  const phasesNode = node({
    work: {
      test: 'runtests',
      phases: [
        { phase: 'red', prompt: 'write a failing test' },
        { phase: 'impl', prompt: 'implement' },
        { phase: 'green', prompt: 'make it pass' },
      ],
    },
  });

  test('RED must fail then GREEN must pass — sends each phase prompt, returns last wait', async () => {
    const w = scriptedWorker([stopResult(), stopResult(), stopResult({ finalMessage: 'last' })]);
    // After red: runtests exits non-zero (good). After green: exits zero (good).
    let testCalls = 0;
    const exec: ExecFn = async (argv) => {
      if (argv[0] === 'runtests') {
        testCalls += 1;
        return said('x', testCalls === 1 ? 1 : 0);
      }
      throw new Error('unexpected exec');
    };
    const result = await runWork(phasesNode, w.worker, exec, '/wt', { timeoutMs: TIMEOUT });
    expect(w.sends).toEqual(['write a failing test', 'implement', 'make it pass']);
    expect(testCalls).toBe(2);
    expect(result.finalMessage).toBe('last');
  });

  test('RED passes immediately (exit 0) → GateFailedError(red)', async () => {
    const w = scriptedWorker([stopResult(), stopResult(), stopResult()]);
    const exec: ExecFn = async () => said('all green already', 0);
    let err: unknown;
    try {
      await runWork(phasesNode, w.worker, exec, '/wt', { timeoutMs: TIMEOUT });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GateFailedError);
    expect((err as GateFailedError).gate).toBe('red');
    expect((err as GateFailedError).evidence).toContain('all green already');
  });

  test('GREEN still fails (non-zero) → GateFailedError(green)', async () => {
    const w = scriptedWorker([stopResult(), stopResult(), stopResult()]);
    let testCalls = 0;
    const exec: ExecFn = async () => {
      testCalls += 1;
      return said(testCalls === 1 ? 'red fails' : 'still failing', 1);
    };
    let err: unknown;
    try {
      await runWork(phasesNode, w.worker, exec, '/wt', { timeoutMs: TIMEOUT });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GateFailedError);
    expect((err as GateFailedError).gate).toBe('green');
    expect((err as GateFailedError).evidence).toContain('still failing');
  });

  test('a non-stop wait during phases short-circuits before the gate runs', async () => {
    const w = scriptedWorker([stopResult({ reason: 'dead' })]);
    let testCalls = 0;
    const exec: ExecFn = async () => {
      testCalls += 1;
      return said('', 1);
    };
    const result = await runWork(phasesNode, w.worker, exec, '/wt', { timeoutMs: TIMEOUT });
    expect(result.reason).toBe('dead');
    expect(testCalls).toBe(0);
    expect(w.sends).toEqual(['write a failing test']);
  });
});

describe('runWork — {command}', () => {
  test('exit 0 → synthetic stop WorkerResult with the output', async () => {
    const n = node({ work: { command: 'echo hi' } });
    const w = scriptedWorker([]);
    const exec: ExecFn = async (argv) => {
      expect(argv).toEqual(['echo', 'hi']);
      return said('hi\n', 0);
    };
    const result = await runWork(n, w.worker, exec, '/wt', { timeoutMs: TIMEOUT });
    expect(result.reason).toBe('stop');
    expect(result.finalMessage).toBe('hi\n');
    expect(result.exitCode).toBe(0);
    expect(result.filesTouched).toEqual([]);
    expect(w.sends).toEqual([]);
  });

  test('non-zero → GateFailedError(command) with the output', async () => {
    const n = node({ work: { command: 'false' } });
    const w = scriptedWorker([]);
    const exec: ExecFn = async () => said('boom', 3);
    let err: unknown;
    try {
      await runWork(n, w.worker, exec, '/wt', { timeoutMs: TIMEOUT });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GateFailedError);
    expect((err as GateFailedError).gate).toBe('command');
    expect((err as GateFailedError).evidence).toContain('boom');
  });
});

describe('promptFor — base prompt + optional evidence', () => {
  test('{prompt} node → the prompt verbatim when no evidence', () => {
    expect(promptFor(node({ work: { prompt: 'hello' } }))).toBe('hello');
  });

  test('evidence is appended as a clearly delimited section', () => {
    const out = promptFor(node({ work: { prompt: 'hello' } }), 'SMOKE failed: exit 1');
    expect(out).toContain('hello');
    expect(out).toContain('SMOKE failed: exit 1');
    // delimited — the base and evidence are separable
    expect(out.indexOf('hello')).toBeLessThan(out.indexOf('SMOKE failed'));
  });
});
