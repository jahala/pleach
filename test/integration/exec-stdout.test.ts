// The exec seam reports the child's stdout separately from the interleaved
// stream: `ExecResult.stdout` is additive — `output` keeps its meaning (both
// streams in arrival order) and every existing caller is untouched. ledger: D14
//
// Why the field exists: a findings log written to stdout (a SARIF 2.1.0
// document from `weeder check --strict`) is only parseable when stderr noise
// is out of the way; the interleaved stream cannot be parsed as the document
// it contains.
//
// Proven here against REAL processes writing to both streams — no doubles.
import { describe, expect, test } from 'bun:test';
import { exec } from '../../src/seams/exec.ts';

describe('exec seam — stdout reported separately', () => {
  test('stdout holds only stdout; output holds both in arrival order', async () => {
    // Sleeps force a deterministic interleaving across the two pipes.
    const result = await exec(
      ['sh', '-c', 'printf A; sleep 0.1; printf B >&2; sleep 0.1; printf C'],
      { cwd: '/tmp' },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('AC');
    expect(result.output).toBe('ABC');
  });

  test('a child that writes only to stderr yields an empty stdout', async () => {
    const result = await exec(['sh', '-c', 'echo err >&2'], { cwd: '/tmp' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.output).toContain('err');
  });

  test('a child that writes only to stdout yields stdout === output', async () => {
    const result = await exec(['echo', 'hello world'], { cwd: '/tmp' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world\n');
    expect(result.output).toBe(result.stdout);
  });

  // The class of problem the field answers: a structured document on stdout
  // survives stderr noise that would break parsing the interleaved stream.
  test('a JSON document on stdout parses even when stderr is noisy', async () => {
    const doc = '{"version":"2.1.0","runs":[]}';
    const result = await exec(
      ['sh', '-c', `printf 'warning: noisy tool\n' >&2; sleep 0.1; printf '%s' '${doc}'`],
      { cwd: '/tmp' },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ version: '2.1.0', runs: [] });
    // The interleaved stream carries the same bytes plus the noise, so it is
    // not the document — that is precisely why `stdout` is reported.
    expect(result.output).toContain('warning: noisy tool');
    expect(() => JSON.parse(result.output)).toThrow();
  });

  // Totality: the interrupt paths resolve with a result, and the result's
  // stdout is honest about what the child managed to write.
  // `exec sleep` replaces the shell so the sleeper IS the spawned process:
  // the kill path here is the one the D1 timeout test already pins.
  test('on timeout, stdout holds what the child wrote before the kill', async () => {
    const result = await exec(['sh', '-c', 'printf early; printf noise >&2; exec sleep 30'], {
      cwd: '/tmp',
      timeoutMs: 500,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('early');
    expect(result.output).toContain('noise');
  });

  test('spawn failure resolves with an empty stdout, never rejects', async () => {
    const result = await exec(['git', 'status'], { cwd: '/nonexistent-pleach-cwd' });
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe('');
    expect(result.output.length).toBeGreaterThan(0);
  });

  // The stdout drain flushes its decoder like the interleaved one does: a
  // trailing incomplete multi-byte UTF-8 sequence is not silently dropped.
  // printf '\xe2\x82' emits the first 2 bytes of '€' (U+20AC: e2 82 ac).
  test('trailing incomplete UTF-8 on stdout is not silently dropped', async () => {
    const result = await exec(['bash', '-c', "printf '\\xe2\\x82'"], { cwd: '/tmp' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});
