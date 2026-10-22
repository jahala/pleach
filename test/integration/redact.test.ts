// issue #107 — the redaction seam, against the real plotplot binary. The seam
// runs `plotplot redact` with the text on stdin and returns stdout; a secret in
// the input never comes back, ordinary text is left alone, and a binary that
// cannot run throws the typed error instead of passing the input through.
//
// The redaction test skips when plotplot is not installed (CI has none); the
// missing-binary test runs everywhere because it needs no plotplot.
import { describe, expect, test } from 'bun:test';
import { RedactError } from '../../src/core/errors.ts';
import { createRedactor } from '../../src/seams/redact.ts';

const HAS_PLOTPLOT = Bun.which('plotplot') !== null;

describe('redact seam — fail closed', () => {
  test('a binary that does not exist throws the typed error, never the input', async () => {
    const redact = createRedactor('/definitely/not/a/plotplot/binary');
    await expect(redact.redact('a secret')).rejects.toBeInstanceOf(RedactError);
  });
});

describe.skipIf(!HAS_PLOTPLOT)('redact seam — the real plotplot binary', () => {
  test('an AKIA-style key is redacted and ordinary text is left alone', async () => {
    const redact = createRedactor('plotplot');
    const key = 'AKIAIOSFODNN7EXAMPLE';
    const out = await redact.redact(`access key: ${key}\nhello world\n`);
    expect(out).not.toContain(key);
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('hello world');
  });

  test('text with no secret comes back unchanged', async () => {
    const redact = createRedactor('plotplot');
    expect(await redact.redact('ordinary prose\n')).toBe('ordinary prose\n');
  });
});
