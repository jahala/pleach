import { describe, expect, test } from 'bun:test';
import { exec } from '../../src/seams/exec.ts';

describe('exec seam', () => {
  test('success: captures stdout and exits 0', async () => {
    const result = await exec(['echo', 'hello world'], { cwd: '/tmp' });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('hello world');
  });

  test('non-zero exit code propagates', async () => {
    const result = await exec(['sh', '-c', 'exit 42'], { cwd: '/tmp' });
    expect(result.exitCode).toBe(42);
  });

  test('cwd is respected', async () => {
    const result = await exec(['pwd'], { cwd: '/tmp' });
    expect(result.exitCode).toBe(0);
    // /tmp on macOS may resolve to /private/tmp
    expect(result.output.trim()).toMatch(/\/tmp$/);
  });

  test('env var is visible to child', async () => {
    const result = await exec(['sh', '-c', 'echo $PLEACH_TEST_VAR'], {
      cwd: '/tmp',
      env: { PLEACH_TEST_VAR: 'sentinel_value' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('sentinel_value');
  });

  // ledger: SEC1 — argv element with shell metacharacters is passed literally, never shell-interpreted
  test('SEC1: argv element with shell metacharacters is passed literally to child', async () => {
    const poisoned = '$(echo pwned); rm -rf /tmp/nope';
    const result = await exec(['echo', poisoned], { cwd: '/tmp' });
    expect(result.exitCode).toBe(0);
    // The child must see the literal string, not the result of shell expansion
    expect(result.output.trim()).toBe(poisoned);
  });

  // ledger: D1 — timeoutMs kills a long-running process quickly and resolves (does not throw)
  test('D1: timeoutMs kills sleep and resolves with non-zero exitCode', async () => {
    const start = Date.now();
    const result = await exec(['sleep', '30'], { cwd: '/tmp', timeoutMs: 500 });
    const elapsed = Date.now() - start;
    // Must resolve (not throw) even on timeout
    expect(result.exitCode).not.toBe(0);
    // Must not have taken anywhere near 30 seconds
    expect(elapsed).toBeLessThan(5000);
  });

  test('stderr is captured in output', async () => {
    const result = await exec(['sh', '-c', 'echo err >&2'], { cwd: '/tmp' });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('err');
  });
});

// Totality: spawn failure (nonexistent cwd) resolves with exit 127 — never rejects.
test('lead-review: nonexistent cwd resolves with exitCode 127, does not reject', async () => {
  const r = await exec(['git', 'status'], { cwd: '/nonexistent-pleach-cwd' });
  expect(r.exitCode).toBe(127);
  expect(r.output.length).toBeGreaterThan(0);
});

// TextDecoder flush: a trailing incomplete multi-byte UTF-8 sequence must not be silently dropped.
// printf '\xe2\x82' emits the first 2 bytes of '€' (U+20AC, 3 bytes: e2 82 ac).
// A decoder used with { stream: true } buffers these bytes waiting for the final byte — without
// an explicit flush call the buffered bytes are silently dropped and output is empty.
// After the fix (decoder.decode() with no args flushes the buffer) output is non-empty
// (U+FFFD replacement character for the incomplete sequence). ledger: D1
test('TextDecoder flush: trailing incomplete UTF-8 sequence is not silently dropped', async () => {
  // Two-byte prefix of the three-byte '€' codepoint (U+20AC: e2 82 ac)
  const result = await exec(['bash', '-c', "printf '\\xe2\\x82'"], { cwd: '/tmp' });
  expect(result.exitCode).toBe(0);
  // Without the decoder flush the buffered bytes are dropped → output is ''.
  // With the flush, the incomplete sequence resolves to U+FFFD (replacement character).
  expect(result.output.length).toBeGreaterThan(0);
});
