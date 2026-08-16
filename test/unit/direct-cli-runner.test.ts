import { describe, expect, test } from 'bun:test';
import { directCliRunner } from '../../examples/three-ways/lib/direct-cli-runner.ts';

// Subject: directCliRunner — the examples/three-ways/lib template for driving
// headless agent CLIs (claude -p / codex exec) as one-shot subprocesses.
// All tests use injected fakes: no real CLI is invoked, no real git is called.

describe('directCliRunner — injected-fake unit tests', () => {
  test('claude build: argv, finalMessage, filesTouched from injected fakes', async () => {
    let capturedArgv: string[] = [];

    const fakeSpawn = (argv: string[], _cwd: string) => {
      capturedArgv = [...argv];
      return {
        stdout: Promise.resolve('built it'),
        exited: Promise.resolve(0),
      };
    };

    const runner = directCliRunner({
      spawn: fakeSpawn,
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

    const fakeSpawn = (argv: string[], _cwd: string) => {
      capturedArgv = [...argv];
      return {
        stdout: Promise.resolve(`Some preamble.\n${auditBlock}\nSome epilogue.`),
        exited: Promise.resolve(0),
      };
    };

    const runner = directCliRunner({
      spawn: fakeSpawn,
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

    const fakeSpawn = (argv: string[], _cwd: string) => {
      capturedArgv = [...argv];
      return { stdout: Promise.resolve('ok'), exited: Promise.resolve(0) };
    };

    const runner = directCliRunner({ spawn: fakeSpawn, changedFiles: async () => [] });
    const worker = await runner.spawnWorker({ cwd: '/tmp/x' });
    await worker.send('build something');
    await worker.wait();

    expect(capturedArgv[0]).toBe('claude');
    expect(capturedArgv).toContain('-p');
  });

  test('model flag is appended when provided', async () => {
    let capturedArgv: string[] = [];

    const fakeSpawn = (argv: string[], _cwd: string) => {
      capturedArgv = [...argv];
      return { stdout: Promise.resolve('ok'), exited: Promise.resolve(0) };
    };

    const runner = directCliRunner({ spawn: fakeSpawn, changedFiles: async () => [] });
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
    const fakeSpawn = (_argv: string[], _cwd: string) => ({
      stdout: Promise.resolve('fatal: something went wrong'),
      exited: Promise.resolve(1),
    });

    const runner = directCliRunner({ spawn: fakeSpawn, changedFiles: async () => [] });
    const worker = await runner.spawnWorker({ provider: 'claude', cwd: '/tmp/x' });
    await worker.send('do it');
    const result = await worker.wait();

    expect(result.reason).toBe('dead');
    expect(result.finalMessage).toBe('fatal: something went wrong');
    expect(result.exitCode).toBe(1);
  });

  test('unsupported provider throws a clear Error', async () => {
    const fakeSpawn = (_argv: string[], _cwd: string) => ({
      stdout: Promise.resolve(''),
      exited: Promise.resolve(0),
    });

    const runner = directCliRunner({ spawn: fakeSpawn, changedFiles: async () => [] });
    const worker = await runner.spawnWorker({ provider: 'gemini', cwd: '/tmp/x' });
    await worker.send('do it');

    await expect(worker.wait()).rejects.toThrow('gemini');
  });

  test('kill() resolves without error (no-op for one-shot CLI)', async () => {
    const runner = directCliRunner({
      spawn: () => ({ stdout: Promise.resolve(''), exited: Promise.resolve(0) }),
      changedFiles: async () => [],
    });

    const worker = await runner.spawnWorker({ provider: 'claude', cwd: '/tmp/x' });
    await expect(worker.kill()).resolves.toBeUndefined();
  });
});
