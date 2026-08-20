// §D's verify path: `pleach receipt <node>` re-hashes the envelope, re-derives
// the status, and checks the git-pinned trailer. PASS / TAMPERED / UNDERIVABLE
// are the only honest outcomes — a forged file, a re-derivation mismatch, and
// a trailer disagreement are all TAMPERED; a missing receipt, an unresolvable
// ref, and a foreign contract version are UNDERIVABLE (nothing proved either way).
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { receiptHash } from '../../src/core/receipt.ts';
import { verifyReceipt } from '../../src/loop/receipt-verify.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, makeHarness } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };

async function closedHarness(): Promise<Harness> {
  const h = makeHarness();
  await runPlan(
    PlanSchema.parse({
      goal: 'g',
      source: 's',
      nodes: [
        {
          id: 'x',
          work: { prompt: 'build x' },
          accept: { smoke: 'smokey' },
          policy: { maxAttempts: 1 },
        },
      ],
    }),
    h.deps,
    OPTS,
  );
  return h;
}

describe('verifyReceipt (§D)', () => {
  test('an untouched close verifies PASS', async () => {
    const h = await closedHarness();
    const check = await verifyReceipt('x', h.deps, '/r');
    expect(check.outcome).toBe('pass');
    if (check.outcome === 'pass') expect(check.receipt.derived).toBe('publishable');
  });

  test('a hand-edited fact is TAMPERED (seal broken)', async () => {
    const h = await closedHarness();
    const r = h.receipts.get('x');
    if (!r) throw new Error('missing receipt');
    h.receipts.set('x', { ...r, facts: { ...r.facts, attempts: 99 } });
    const check = await verifyReceipt('x', h.deps, '/r');
    expect(check.outcome).toBe('tampered');
  });

  test('a re-sealed forgery still fails: the commit trailer pins the original hash', async () => {
    const h = await closedHarness();
    const r = h.receipts.get('x');
    if (!r) throw new Error('missing receipt');
    // The forger edits a fact AND re-hashes — internal consistency holds, but
    // the trailer in immutable history disagrees.
    const facts = { ...r.facts, attempts: 99 };
    h.receipts.set('x', { ...r, facts, sha256: receiptHash(facts, r.derived) });
    const check = await verifyReceipt('x', h.deps, '/r');
    expect(check.outcome).toBe('tampered');
    if (check.outcome === 'tampered') expect(check.detail).toContain('trailer');
  });

  test('a claimed status the facts do not imply is TAMPERED', async () => {
    const h = await closedHarness();
    const r = h.receipts.get('x');
    if (!r) throw new Error('missing receipt');
    const forged = {
      ...r,
      derived: 'publishable' as const,
      facts: { ...r.facts, status: 'failed' as const },
    };
    h.receipts.set('x', { ...forged, sha256: receiptHash(forged.facts, forged.derived) });
    const check = await verifyReceipt('x', h.deps, '/r');
    expect(check.outcome).toBe('tampered');
  });

  test('no receipt on file is UNDERIVABLE', async () => {
    const h = makeHarness();
    const check = await verifyReceipt('ghost', h.deps, '/r');
    expect(check.outcome).toBe('underivable');
  });

  test('a foreign contract version is UNDERIVABLE — the fence fails honestly', async () => {
    const h = await closedHarness();
    const r = h.receipts.get('x');
    if (!r) throw new Error('missing receipt');
    const facts = { ...r.facts, contractVersion: '0.9.0' };
    h.receipts.set('x', { ...r, facts, sha256: receiptHash(facts, r.derived) });
    const check = await verifyReceipt('x', h.deps, '/r');
    expect(check.outcome).toBe('underivable');
    if (check.outcome === 'underivable') expect(check.detail).toContain('0.9.0');
  });

  test('an unresolvable ref is UNDERIVABLE', async () => {
    const h = await closedHarness();
    // Simulate branch deletion: the ref map forgets node/x.
    h.git.refs.delete('node/x');
    h.git.commitMessages.delete('node/x');
    const check = await verifyReceipt('x', h.deps, '/r');
    expect(check.outcome).toBe('underivable');
  });
});
