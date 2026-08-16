import { describe, expect, test } from 'bun:test';
import { directCliRunner, type SpawnHandle } from '../../src/adapters/direct-cli.ts';
import { WorkerSeamError } from '../../src/core/errors.ts';

// Subject: directCliRunner — the bundled RunnerSeam for headless agent CLIs
// (claude -p / codex exec) as one-shot subprocesses. The argv table is pinned
// here so provider-CLI flag drift breaks CI, not a run.
// All tests use injected fakes: no real CLI is invoked, no real git is called.

function resolvedHandle(stdout: string, exitCode: number): SpawnHandle {
  return {
    stdout: Promise.resolve(stdout),
    exited: Promise.resolve(exitCode),
    kill: () => {},
  };
}

describe('directCliRunner — injected-fake unit tests', () => {
  test('claude build: argv, finalMessage, filesTouched from injected fakes', async () => {
    let capturedArgv: string[] = [];

    const runner = directCliRunner({
      spawn: (argv, _cwd) => {
        capturedArgv = [...argv];
        return resolvedHandle('built it', 0);
      },
      changedFiles: async () => ['src/x.ts'],
    });

    const worker = await runner.spawnWorker({ provider: 'claude', cwd: '/tmp/x' });
    await worker.send('do it');
    const result = await worker.wait();

    expect(result.finalMessage).toBe('built it');
    expect(result.filesTouched).toEqual(['src/x.ts']);
    expect(result.reason).toBe('stop');
    expect(result.telemetry).toEqual({});
    expect(capturedArgv).toEqual([
      'claude',
      '-p',
      'do it',
      '--permission-mode',
      'bypassPermissions',
    ]);
  });

  test('codex audit: argv shape and audit-result fence survives verbatim into finalMessage', async () => {
    let capturedArgv: string[] = [];
    const auditBlock =
      '```tend-audit-result\n{"verdicts":[{"check":"ttt","verdict":"pass","reasons":[]}],"drift":[]}\n```';

    const runner = directCliRunner({
      spawn: (argv, _cwd) => {
        capturedArgv = [...argv];
        return resolvedHandle(`Some preamble.\n${auditBlock}\nSome epilogue.`, 0);
      },
      changedFiles: async () => [],
    });

    const worker = await runner.spawnWorker({ provider: 'codex', cwd: '/tmp/x' });
    await worker.send('audit the work in this worktree');
    const result = await worker.wait();

    expect(capturedArgv).toEqual([
      'codex',
      'exec',
      'audit the work in this worktree',
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
    // The fence block must survive VERBATIM (audit-egress passthrough).
    expect(result.finalMessage).toContain(auditBlock);
  });

  test('default provider (undefined) produces the claude argv', async () => {
    let capturedArgv: string[] = [];

    const runner = directCliRunner({
      spawn: (argv, _cwd) => {
        capturedArgv = [...argv];
        return resolvedHandle('ok', 0);
      },
      changedFiles: async () => [],
    });
    const worker = await runner.spawnWorker({ cwd: '/tmp/x' });
    await worker.send('build something');
    await worker.wait();

    expect(capturedArgv[0]).toBe('claude');
    expect(capturedArgv).toContain('-p');
  });

  test('model flag is appended when provided', async () => {
    let capturedArgv: string[] = [];

    const runner = directCliRunner({
      spawn: (argv, _cwd) => {
        capturedArgv = [...argv];
        return resolvedHandle('ok', 0);
      },
      changedFiles: async () => [],
    });
    const worker = await runner.spawnWorker({
      provider: 'claude',
      model: 'claude-opus-4-5',
      cwd: '/tmp/x',
    });
    await worker.send('build');
    await worker.wait();

    expect(capturedArgv).toContain('--model');
    expect(capturedArgv[capturedArgv.indexOf('--model') + 1]).toBe('claude-opus-4-5');
  });

  test('nonzero exit maps reason to dead', async () => {
    const runner = directCliRunner({
      spawn: () => resolvedHandle('fatal: something went wrong', 1),
      changedFiles: async () => [],
    });
    const worker = await runner.spawnWorker({ provider: 'claude', cwd: '/tmp/x' });
    await worker.send('do it');
    const result = await worker.wait();

    expect(result.reason).toBe('dead');
    expect(result.finalMessage).toBe('fatal: something went wrong');
    expect(result.exitCode).toBe(1);
  });

  test('unsupported provider throws a clear Error', async () => {
    const runner = directCliRunner({
      spawn: () => resolvedHandle('', 0),
      changedFiles: async () => [],
    });
    const worker = await runner.spawnWorker({ provider: 'gemini', cwd: '/tmp/x' });
    await worker.send('do it');

    await expect(worker.wait()).rejects.toThrow('gemini');
  });

  test('timeoutMs kills the process and maps reason to timeout (ledger D1)', async () => {
    let killed = false;
    // A hanging CLI: promises resolve only when kill() fires.
    let resolveStdout: (s: string) => void = () => {};
    let resolveExit: (n: number) => void = () => {};
    const handle: SpawnHandle = {
      stdout: new Promise((res) => {
        resolveStdout = res;
      }),
      exited: new Promise((res) => {
        resolveExit = res;
      }),
      kill: () => {
        killed = true;
        resolveStdout('partial output before the hang');
        resolveExit(137);
      },
    };

    const runner = directCliRunner({
      spawn: () => handle,
      changedFiles: async () => [],
    });
    const worker = await runner.spawnWorker({ provider: 'claude', cwd: '/tmp/x' });
    await worker.send('hang forever');
    const result = await worker.wait({ timeoutMs: 20 });

    expect(killed).toBe(true);
    expect(result.reason).toBe('timeout');
    expect(result.finalMessage).toBe('partial output before the hang');
  });

  test('kill() aborts an in-flight invocation', async () => {
    let killed = false;
    let resolveStdout: (s: string) => void = () => {};
    let resolveExit: (n: number) => void = () => {};
    const handle: SpawnHandle = {
      stdout: new Promise((res) => {
        resolveStdout = res;
      }),
      exited: new Promise((res) => {
        resolveExit = res;
      }),
      kill: () => {
        killed = true;
        resolveStdout('');
        resolveExit(137);
      },
    };

    const runner = directCliRunner({
      spawn: () => handle,
      changedFiles: async () => [],
    });
    const worker = await runner.spawnWorker({ provider: 'claude', cwd: '/tmp/x' });
    await worker.send('long build');
    const waiting = worker.wait();
    await worker.kill();
    const result = await waiting;

    expect(killed).toBe(true);
    expect(result.reason).not.toBe('stop');
  });

  test('kill() before/after a completed wait resolves without error', async () => {
    const runner = directCliRunner({
      spawn: () => resolvedHandle('done', 0),
      changedFiles: async () => [],
    });
    const worker = await runner.spawnWorker({ provider: 'claude', cwd: '/tmp/x' });
    await expect(worker.kill()).resolves.toBeUndefined(); // nothing in flight
    await worker.send('do it');
    await worker.wait();
    await expect(worker.kill()).resolves.toBeUndefined(); // already finished
  });

  test('a second send throws WorkerSeamError — single-turn by contract', async () => {
    const runner = directCliRunner({
      spawn: () => resolvedHandle('ok', 0),
      changedFiles: async () => [],
    });
    const worker = await runner.spawnWorker({ provider: 'claude', cwd: '/tmp/x' });
    await worker.send('turn one');
    await worker.wait();

    await expect(worker.send('turn two')).rejects.toBeInstanceOf(WorkerSeamError);
  });
});
