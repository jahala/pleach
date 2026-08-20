// Adoption ladder §D — the close receipt's pure heart. A receipt is minted at
// settle from facts frozen at classify time (the loki lesson: hash nothing
// that settles later — refs and the ledger's close decision ride OUTSIDE the
// integrity envelope, bound by git instead). deriveStatus is the shared
// recomputation the mint and verify paths both run; degraded[] makes "no
// coverage is not coverage" a recorded fact.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { MintFacts, Receipt } from '../../src/core/receipt.ts';
import {
  CONTRACT_VERSION,
  canonicalJson,
  computeDegraded,
  deriveStatus,
  mintReceipt,
  rehash,
  sha256Hex,
} from '../../src/core/receipt.ts';

function makeFacts(overrides: Partial<MintFacts> = {}): MintFacts {
  return {
    node: 'x',
    source: 'plan.tend.html',
    status: 'done',
    attempts: 1,
    provider: 'claude',
    gates: [
      { gate: 'hygiene', exitCode: 0 },
      { gate: 'smoke:bun test', exitCode: 0 },
    ],
    acceptance: { smoke: 'bun test' },
    degraded: ['audit:unconfigured'],
    stagedFiles: 3,
    telemetry: {},
    durationMs: 1234,
    pleachVersion: '0.0.1',
    ...overrides,
  };
}

describe('canonicalJson', () => {
  test('key order never changes the serialization; arrays keep their order', () => {
    const a = { b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } };
    const b = { a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
  });
});

describe('sha256Hex', () => {
  test('matches the NIST vector for "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('mintReceipt', () => {
  test('stamps the current contract version and hashes facts + derived', () => {
    const r = mintReceipt(makeFacts());
    expect(r.facts.contractVersion).toBe(CONTRACT_VERSION);
    expect(r.derived).toBe('publishable');
    expect(r.sha256).toBe(sha256Hex(canonicalJson({ facts: r.facts, derived: r.derived })));
  });

  test('the hash is stable under fact key reordering', () => {
    const a = mintReceipt(makeFacts());
    const reordered = Object.fromEntries(Object.entries(makeFacts()).reverse());
    const b = mintReceipt(reordered as unknown as MintFacts);
    expect(a.sha256).toBe(b.sha256);
  });

  test('a tampered fact flips rehash to false', () => {
    const r = mintReceipt(makeFacts());
    const forged: Receipt = { ...r, facts: { ...r.facts, attempts: 99 } };
    expect(rehash(r)).toBe(true);
    expect(rehash(forged)).toBe(false);
  });

  test('refs sit outside the integrity envelope — adding them never breaks the hash', () => {
    const r = mintReceipt(makeFacts());
    const withRefs: Receipt = { ...r, refs: { diffRef: 'abc123' } };
    expect(rehash(withRefs)).toBe(true);
  });
});

describe('deriveStatus', () => {
  test('done + green gates + no audit fail derives publishable', () => {
    const r = mintReceipt(makeFacts());
    expect(deriveStatus(r.facts)).toEqual({ ok: true, status: 'publishable' });
  });

  test('a red gate derives quarantined even on a done verdict', () => {
    const r = mintReceipt(makeFacts({ gates: [{ gate: 'smoke:bun test', exitCode: 1 }] }));
    expect(deriveStatus(r.facts)).toEqual({ ok: true, status: 'quarantined' });
  });

  test('every non-done verdict class derives quarantined', () => {
    for (const status of ['failed', 'dead', 'timeout', 'rejected', 'aborted', 'blocked'] as const) {
      const r = mintReceipt(makeFacts({ status }));
      expect(deriveStatus(r.facts)).toEqual({ ok: true, status: 'quarantined' });
    }
  });

  test('an audit fail or skip blocks publishable; partial does not (tend adjudicates partials)', () => {
    const pass = mintReceipt(makeFacts({ audit: [{ check: 'c1', verdict: 'pass', reasons: [] }] }));
    expect(deriveStatus(pass.facts)).toEqual({ ok: true, status: 'publishable' });

    const partial = mintReceipt(
      makeFacts({ audit: [{ check: 'c1', verdict: 'partial', reasons: ['honest middle'] }] }),
    );
    expect(deriveStatus(partial.facts)).toEqual({ ok: true, status: 'publishable' });

    const fail = mintReceipt(
      makeFacts({ audit: [{ check: 'c1', verdict: 'fail', reasons: ['broken'] }] }),
    );
    expect(deriveStatus(fail.facts)).toEqual({ ok: true, status: 'quarantined' });

    const skip = mintReceipt(
      makeFacts({ audit: [{ check: 'c1', verdict: 'skip', reasons: ['auditor died'] }] }),
    );
    expect(deriveStatus(skip.facts)).toEqual({ ok: true, status: 'quarantined' });
  });

  test('the version fence: a foreign contract version fails derivation honestly', () => {
    const r = mintReceipt(makeFacts());
    const old = { ...r.facts, contractVersion: '0.9.0' };
    const d = deriveStatus(old);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain('0.9.0');
  });
});

describe('computeDegraded', () => {
  test('unconfigured checks become recorded facts', () => {
    expect(computeDegraded({ accept: {} })).toEqual(['smoke:unconfigured', 'audit:unconfigured']);
    expect(computeDegraded({ accept: { smoke: 'bun test' } })).toEqual(['audit:unconfigured']);
    expect(
      computeDegraded({
        accept: { smoke: 'bun test', audit: { command: 'tend audit f', provider: 'codex' } },
      }),
    ).toEqual([]);
  });
});

describe('the version constant', () => {
  test('CONTRACT_VERSION matches the canonical contract doc header', () => {
    const header = readFileSync('docs/contract/plan-schema.md', 'utf8').split('\n')[0] ?? '';
    expect(header).toContain(`v${CONTRACT_VERSION}`);
  });
});
