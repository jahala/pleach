// ledger: D19 — a test quoting AWS's documentation key was refused at close
// (2026-09-09): the secrets battery read a vendor's manual as a leak. The
// battery allowlists the credentials vendors print in their own documentation,
// exactly: the string, never a pattern, so one character away from an example
// is a credential like any other.
//
// Every credential here is assembled at runtime from two halves. This repo
// gates its own diffs with this battery, and a whole example on an added line
// is what the gate refused before this fix: the file that proves the allowlist
// would fail it.
import { describe, expect, test } from 'bun:test';
import * as hygiene from '../../src/core/hygiene.ts';

// The examples as each vendor prints them, read on 2026-09-11 from:
//   AWS     https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html
//   GitHub  https://docs.github.com/en/rest/credentials/revoke
//   Stripe  https://docs.stripe.com/api/authentication (4S68…)
//           https://docs.stripe.com/payments/vault-and-forward (4eC39…)
// Reference list: weeder's X1 `PUBLISHED` (src/core/rules/check/x1.rs, a
// private checkout). Its GitHub entry (`ghp_16C7e…`) is not on docs.github.com;
// the page prints it as `gho_`, a prefix this battery has no detector for.
const EXAMPLES = [
  { name: 'AWS access key id', stamp: 'AKIA', tail: 'IOSFODNN7EXAMPLE', host: 'aws.amazon.com' },
  {
    name: 'AWS secret access key',
    stamp: 'wJalrXUtnFEMI',
    tail: '/K7MDENG/bPxRfiCYEXAMPLEKEY',
    host: 'aws.amazon.com',
  },
  {
    name: 'GitHub personal access token',
    stamp: 'ghp_',
    tail: '1234567890abcdef1234567890abcdef12345678',
    host: 'github.com',
  },
  {
    name: 'GitHub fine-grained token',
    stamp: 'github_pat_',
    tail: '0A1B2C3D4E5F6G7H8I9J0K_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456',
    host: 'github.com',
  },
  {
    name: 'Stripe test secret key (API reference)',
    stamp: 'sk_test_',
    tail: '4S68v29DeKcE4RxJcrJnUn5s',
    host: 'stripe.com',
  },
  {
    name: 'Stripe test secret key (guides)',
    stamp: 'sk_test_',
    tail: '4eC39HqLyjWDarjtT1zdp7dc',
    host: 'stripe.com',
  },
].map((e) => ({ ...e, value: e.stamp + e.tail }));

const CLASSES = ['0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'];

// The next character in the last character's own class: same length, same
// shape, so every detector that fires on the example fires on this.
function nextOfClass(ch: string): string {
  const cls = CLASSES.find((c) => c.includes(ch)) ?? '0123456789';
  return cls.charAt((cls.indexOf(ch) + 1) % cls.length);
}

const oneOff = (value: string): string => value.slice(0, -1) + nextOfClass(value.slice(-1));
const extended = (value: string): string => value + nextOfClass(value.slice(-1));

// One added line in a test file, the value assigned to a name a credential
// detector reads, so the AWS secret (which carries no issuer prefix) is in
// reach of the battery too.
function scan(line: string): hygiene.HygieneFailure | null {
  return hygiene.checkDiffHygiene({
    workKind: 'prompt',
    stagedFiles: ['test/auth.test.ts'],
    diff: `diff --git a/test/auth.test.ts b/test/auth.test.ts\n+++ b/test/auth.test.ts\n${line}\n`,
    numstat: [{ file: 'test/auth.test.ts', added: 1, deleted: 0 }],
    finalMessage: '',
  });
}
const quoting = (value: string): string => `+const secret = "${value}";`;

describe('the secrets battery allowlists documented example credentials (D19)', () => {
  test('a diff quoting a documented example passes hygiene', () => {
    for (const ex of EXAMPLES) {
      expect({ example: ex.name, finding: scan(quoting(ex.value)) }).toEqual({
        example: ex.name,
        finding: null,
      });
    }
  });

  test('the same credential with one character changed is refused', () => {
    for (const ex of EXAMPLES) {
      expect({ example: ex.name, kind: scan(quoting(oneOff(ex.value)))?.kind }).toEqual({
        example: ex.name,
        kind: 'secret',
      });
    }
  });

  test('a token that only begins with an example is refused', () => {
    for (const ex of EXAMPLES) {
      expect({ example: ex.name, kind: scan(quoting(extended(ex.value)))?.kind }).toEqual({
        example: ex.name,
        kind: 'secret',
      });
    }
  });

  test('a line quoting an example beside a live-shaped key is refused', () => {
    for (const ex of EXAMPLES) {
      const line = `+const secret = "${ex.value}", password = "${oneOff(ex.value)}";`;
      expect({ example: ex.name, kind: scan(line)?.kind }).toEqual({
        example: ex.name,
        kind: 'secret',
      });
    }
  });

  test('every documented example is vendored with a source page on its vendor docs host', () => {
    const entries = hygiene.DOCUMENTED_EXAMPLE_CREDENTIALS;
    expect(entries).toBeArray();
    for (const ex of EXAMPLES) {
      const entry = entries.find((e) => e.stamp + e.tail === ex.value);
      expect({ example: ex.name, host: entry && new URL(entry.source).hostname }).toEqual({
        example: ex.name,
        host: expect.stringMatching(new RegExp(`(^|\\.)${ex.host.replaceAll('.', '\\.')}$`)),
      });
    }
  });

  test('every allowlist entry is an exact string with a source, and one the battery would otherwise refuse', () => {
    const entries = hygiene.DOCUMENTED_EXAMPLE_CREDENTIALS;
    expect(entries).toBeArray();
    for (const entry of entries) {
      const value = entry.stamp + entry.tail;
      expect(new URL(entry.source).protocol).toBe('https:');
      expect({ value, finding: scan(quoting(value)) }).toEqual({ value, finding: null });
      for (const near of [oneOff(value), extended(value)]) {
        expect({ near, kind: scan(quoting(near))?.kind }).toEqual({ near, kind: 'secret' });
      }
    }
  });
});
