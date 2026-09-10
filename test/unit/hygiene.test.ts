// Adoption ladder §E — the hygiene gate's pure detectors. Two real incident
// classes from Bernstein's archive ("verified but did nothing", "verified but
// destructive") plus the credential class every public repo fears. High
// precision over recall: a noisy gate gets disabled by its users, which is
// worse than a narrow one.
import { describe, expect, test } from 'bun:test';
import { checkDiffHygiene } from '../../src/core/hygiene.ts';

const NUM = (file: string, added: number, deleted: number) => ({ file, added, deleted });

// A live-shaped AWS key id, assembled from halves so this file's own diff does
// not trip the battery it tests. Not AWS's documented example: that one is
// allowlisted (D19, hygiene-allowlist.test.ts).
const AWS_KEY = ['AKIA', 'Q3VZ7K2MXW9RT4LB'].join('');

describe('checkDiffHygiene (§E)', () => {
  test('clean diff passes', () => {
    const r = checkDiffHygiene({
      workKind: 'prompt',
      stagedFiles: ['src/a.ts'],
      diff: '+export const a = 1;\n',
      numstat: [NUM('src/a.ts', 1, 0)],
      finalMessage: '',
    });
    expect(r).toBeNull();
  });

  test('empty staged set on agent work is the empty-diff failure', () => {
    const r = checkDiffHygiene({
      workKind: 'prompt',
      stagedFiles: [],
      diff: '',
      numstat: [],
      finalMessage: 'all done!',
    });
    expect(r?.kind).toBe('empty-diff');
    expect(r?.evidence).toContain('no changes');
  });

  test('command work may legitimately be effect-free', () => {
    const r = checkDiffHygiene({
      workKind: 'command',
      stagedFiles: [],
      diff: '',
      numstat: [],
      finalMessage: '',
    });
    expect(r).toBeNull();
  });

  test('an AWS key in the added lines is a secrets failure naming the file', () => {
    const diff = [
      'diff --git a/src/config.ts b/src/config.ts',
      '+++ b/src/config.ts',
      `+const key = "${AWS_KEY}";`,
    ].join('\n');
    const r = checkDiffHygiene({
      workKind: 'prompt',
      stagedFiles: ['src/config.ts'],
      diff,
      numstat: [NUM('src/config.ts', 1, 0)],
      finalMessage: '',
    });
    expect(r?.kind).toBe('secret');
    expect(r?.evidence).toContain('src/config.ts');
  });

  test('a private key block is a secrets failure', () => {
    const diff = '+++ b/deploy/key.pem\n+-----BEGIN RSA PRIVATE KEY-----\n+abc\n';
    const r = checkDiffHygiene({
      workKind: 'prompt',
      stagedFiles: ['deploy/key.pem'],
      diff,
      numstat: [NUM('deploy/key.pem', 2, 0)],
      finalMessage: '',
    });
    expect(r?.kind).toBe('secret');
  });

  test('REMOVING a secret is not a violation (deleted lines are not scanned)', () => {
    const diff = `+++ b/src/config.ts\n-const key = "${AWS_KEY}";\n+const key = env.KEY;\n`;
    const r = checkDiffHygiene({
      workKind: 'prompt',
      stagedFiles: ['src/config.ts'],
      diff,
      numstat: [NUM('src/config.ts', 1, 1)],
      finalMessage: '',
    });
    expect(r).toBeNull();
  });

  test('>50% and >100 lines deleted in one file trips the deletion wire', () => {
    const r = checkDiffHygiene({
      workKind: 'prompt',
      stagedFiles: ['src/big.ts'],
      diff: '+++ b/src/big.ts\n',
      numstat: [NUM('src/big.ts', 10, 150)],
      finalMessage: '',
    });
    expect(r?.kind).toBe('deletion');
    expect(r?.evidence).toContain('src/big.ts');
  });

  test('a large deletion the worker explicitly re-states passes the wire', () => {
    const r = checkDiffHygiene({
      workKind: 'prompt',
      stagedFiles: ['src/big.ts'],
      diff: '+++ b/src/big.ts\n',
      numstat: [NUM('src/big.ts', 10, 150)],
      finalMessage: 'Rewrote the module. DELETION INTENDED: src/big.ts loses its legacy half.',
    });
    expect(r).toBeNull();
  });

  test('small deletions never trip (both thresholds required)', () => {
    const r = checkDiffHygiene({
      workKind: 'prompt',
      stagedFiles: ['src/small.ts'],
      diff: '+++ b/src/small.ts\n',
      numstat: [NUM('src/small.ts', 1, 60)], // >50% but not >100 lines
      finalMessage: '',
    });
    expect(r).toBeNull();
  });
});
