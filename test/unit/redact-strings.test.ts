// ledger: D37 — one redactor call per value, never one per string: the real
// redactor is a process, and a journal line holds a dozen strings.
import { describe, expect, test } from 'bun:test';
import { RedactError } from '../../src/core/errors.ts';
import { redactStrings } from '../../src/core/redact.ts';

describe('redactStrings', () => {
  test('redacts every string of a nested value in ONE redactor call', async () => {
    let calls = 0;
    const redact = async (text: string) => {
      calls += 1;
      return text.replaceAll('sekret', '[REDACTED]');
    };
    const out = await redactStrings(
      {
        a: 'x sekret y',
        b: ['plain', { c: 'sekret' }],
        n: 3,
        m: null,
        multi: 'line1\nsekret\nline3',
      },
      redact,
    );
    expect(out).toEqual({
      a: 'x [REDACTED] y',
      b: ['plain', { c: '[REDACTED]' }],
      n: 3,
      m: null,
      multi: 'line1\n[REDACTED]\nline3',
    });
    expect(calls).toBe(1);
  });

  test('a value with no strings makes no call', async () => {
    let calls = 0;
    const out = await redactStrings({ n: 1, ok: true }, async (t) => {
      calls += 1;
      return t;
    });
    expect(out).toEqual({ n: 1, ok: true });
    expect(calls).toBe(0);
  });

  test('a redactor that loses the boundaries fails closed', async () => {
    const lossy = async () => 'everything merged';
    await expect(redactStrings({ a: 'one', b: 'two' }, lossy)).rejects.toBeInstanceOf(RedactError);
  });
});
