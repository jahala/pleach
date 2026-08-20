// §D in the ladder: a receipt is minted at settle (close AND quarantine),
// its hash rides the commit trailer, the file lands in the receipt store,
// degraded[] surfaces on the close event, and a recorded acceptance that no
// longer matches the plan's current acceptance re-dispatches the node instead
// of skip-trusting a stale close (tend2's serve finding, 2026-08-19).
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { CONTRACT_VERSION, mintReceipt, rehash, sha256Hex } from '../../src/core/receipt.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness, stop } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };

function plan(nodes: unknown[]) {
  return PlanSchema.parse({ goal: 'g', source: 's', nodes });
}

describe('receipts in the ladder (§D)', () => {
  test('a close mints a sealed receipt: trailer pinned, refs bound, facts frozen', async () => {
    const h = makeHarness();
    const summary = await runPlan(
      plan([
        {
          id: 'x',
          work: { prompt: 'build x' },
          accept: { smoke: 'smokey' },
          policy: { maxAttempts: 1 },
        },
      ]),
      h.deps,
      OPTS,
    );

    expect(summary.closed).toEqual(['x']);
    const receipt = h.receipts.get('x');
    if (receipt === undefined) throw new Error('no receipt minted on close');
    expect(rehash(receipt)).toBe(true);
    expect(receipt.derived).toBe('publishable');
    expect(receipt.facts.status).toBe('done');
    expect(receipt.facts.contractVersion).toBe(CONTRACT_VERSION);
    expect(receipt.facts.pleachVersion).toBe('0.0.1-test');
    expect(receipt.facts.provider).toBe('claude');
    expect(receipt.facts.acceptance).toEqual({ smoke: 'smokey' });
    // The ladder, in order, all green.
    expect(receipt.facts.gates).toEqual([
      { gate: 'marker', exitCode: 0 },
      { gate: 'hygiene', exitCode: 0 },
      { gate: 'smoke', exitCode: 0 },
    ]);
    // Refs are bound by git, outside the envelope.
    expect(receipt.refs?.diffRef).toBe(h.git.refs.get('node/x'));
    // The trailer pins the hash in the published commit.
    expect(h.git.commitMessages.get('node/x')).toContain(`receipt-sha256: ${receipt.sha256}`);
    const event = h.journal.find((e) => e.event === 'receipt' && e.node === 'x');
    expect(event?.sha256).toBe(receipt.sha256);
  });

  test('a quarantine mints too — failed facts, quarantine refs, trailer on the evidence commit', async () => {
    const h = makeHarness({
      execScript: (argv) =>
        argv[0] === 'smokey' ? { output: 'red', exitCode: 1 } : { output: '', exitCode: 0 },
    });
    const summary = await runPlan(
      plan([
        {
          id: 'x',
          work: { prompt: 'build x' },
          accept: { smoke: 'smokey' },
          policy: { maxAttempts: 1 },
        },
      ]),
      h.deps,
      OPTS,
    );

    expect(summary.failed).toEqual(['x']);
    expect(summary.quarantined).toEqual(['x']);
    const receipt = h.receipts.get('x');
    if (receipt === undefined) throw new Error('no receipt minted on quarantine');
    expect(rehash(receipt)).toBe(true);
    expect(receipt.derived).toBe('quarantined');
    expect(receipt.facts.status).toBe('failed');
    // The failing gate's record references the journal's verbatim tail by hash
    // (the journal keeps the text; the sealed receipt keeps the pointer).
    expect(receipt.facts.gates).toContainEqual({
      gate: 'smoke',
      exitCode: 1,
      outputTailSha: sha256Hex('red'),
    });
    expect(receipt.refs?.quarantineBranch).toBe('quarantine/x');
    expect(receipt.refs?.quarantineSha).toBe(h.git.refs.get('quarantine/x'));
    expect(h.git.commitMessages.get('quarantine/x')).toContain(`receipt-sha256: ${receipt.sha256}`);
  });

  test('an auditor that dies records skip — "never adjudicated", distinct from fail', async () => {
    const h = makeHarness({
      waitScript: (ctx) => (ctx.role === 'audit' ? stop({ reason: 'dead' }) : stop()),
    });
    const summary = await runPlan(
      plan([
        {
          id: 'x',
          work: { prompt: 'build x' },
          accept: { audit: { command: 'auditcmd', provider: 'codex' } },
          policy: { maxAttempts: 1 },
        },
      ]),
      h.deps,
      OPTS,
    );

    expect(summary.failed).toEqual(['x']);
    const receipt = h.receipts.get('x');
    if (receipt === undefined) throw new Error('no receipt minted');
    expect(receipt.facts.audit).toEqual([
      { check: '(audit)', verdict: 'skip', reasons: [expect.stringContaining('dead')] },
    ]);
    expect(receipt.derived).toBe('quarantined');
  });

  test('a passing audit relays its verdicts verbatim into the receipt', async () => {
    const h = makeHarness();
    await runPlan(
      plan([
        {
          id: 'x',
          work: { prompt: 'build x' },
          accept: { audit: { command: 'auditcmd', provider: 'codex' } },
          policy: { maxAttempts: 1 },
        },
      ]),
      h.deps,
      OPTS,
    );

    const receipt = h.receipts.get('x');
    expect(receipt?.facts.audit).toEqual([{ check: 'c', verdict: 'pass', reasons: [] }]);
  });

  test('degraded[] is a recorded fact and surfaces on the close event', async () => {
    const h = makeHarness();
    await runPlan(
      plan([{ id: 'x', work: { prompt: 'build x' }, policy: { maxAttempts: 1 } }]),
      h.deps,
      OPTS,
    );

    const receipt = h.receipts.get('x');
    expect(receipt?.facts.degraded).toEqual(['smoke:unconfigured', 'audit:unconfigured']);
    const closedEvent = h.journal.find((e) => e.event === 'closed' && e.node === 'x');
    expect(closedEvent?.degraded).toEqual(['smoke:unconfigured', 'audit:unconfigured']);
  });

  test('acceptance evolution invalidates a skip: changed smoke string re-dispatches the node', async () => {
    const stale = mintReceipt({
      node: 'x',
      source: 's',
      status: 'done',
      attempts: 1,
      provider: 'claude',
      gates: [],
      acceptance: { smoke: 'old-cmd' },
      degraded: ['audit:unconfigured'],
      stagedFiles: 1,
      telemetry: {},
      durationMs: 1,
      pleachVersion: '0.0.1-test',
    });
    const h = makeHarness({
      closed: new Map([['x', 'sha-old']]),
      refs: { 'node/x': 'sha-old' },
      receiptsSeed: { x: stale },
    });
    const summary = await runPlan(
      plan([
        {
          id: 'x',
          work: { prompt: 'build x' },
          accept: { smoke: 'new-cmd' },
          policy: { maxAttempts: 1 },
        },
      ]),
      h.deps,
      OPTS,
    );

    expect(summary.alreadyVerified).toEqual([]);
    expect(summary.closed).toEqual(['x']); // re-ran and re-closed
    expect(h.log.count('spawn:build', 'x')).toBe(1);
    const event = h.journal.find((e) => e.event === 'acceptance-changed' && e.node === 'x');
    expect(event?.recorded).toEqual({ smoke: 'old-cmd' });
    expect(event?.current).toEqual({ smoke: 'new-cmd' });
    // The fresh close overwrote the stale receipt — and points back at it, so
    // the settle trail survives the overwrite.
    expect(h.receipts.get('x')?.facts.acceptance).toEqual({ smoke: 'new-cmd' });
    expect(h.receipts.get('x')?.refs?.previousReceiptSha256).toBe(stale.sha256);
  });

  test('invalidation cascades: a closed dependent of a re-dispatched node rebuilds too', async () => {
    const staleX = mintReceipt({
      node: 'x',
      source: 's',
      status: 'done',
      attempts: 1,
      provider: 'claude',
      gates: [],
      acceptance: { smoke: 'old-cmd' },
      degraded: ['audit:unconfigured'],
      stagedFiles: 1,
      telemetry: {},
      durationMs: 1,
      pleachVersion: '0.0.1-test',
    });
    const h = makeHarness({
      closed: new Map([
        ['x', 'sha-x'],
        ['y', 'sha-y'],
      ]),
      refs: { 'node/x': 'sha-x', 'node/y': 'sha-y' },
      receiptsSeed: { x: staleX }, // y's own acceptance never changed
    });
    const summary = await runPlan(
      plan([
        {
          id: 'x',
          work: { prompt: 'build x' },
          accept: { smoke: 'new-cmd' },
          policy: { maxAttempts: 1 },
        },
        { id: 'y', work: { prompt: 'build y' }, needs: ['x'], policy: { maxAttempts: 1 } },
      ]),
      h.deps,
      OPTS,
    );

    // y's close embedded the OLD x — skip-trusting it would land stale work.
    expect(summary.alreadyVerified).toEqual([]);
    expect(summary.closed).toEqual(['x', 'y']);
    expect(h.log.count('spawn:build', 'y')).toBe(1);
    const cascade = h.journal.find((e) => e.event === 'acceptance-cascade' && e.node === 'y');
    expect(cascade?.via).toBe('x');
  });

  test('unchanged acceptance keeps the skip; a receiptless close stays trusted (legacy)', async () => {
    const matching = mintReceipt({
      node: 'x',
      source: 's',
      status: 'done',
      attempts: 1,
      provider: 'claude',
      gates: [],
      acceptance: { smoke: 'same-cmd' },
      degraded: ['audit:unconfigured'],
      stagedFiles: 1,
      telemetry: {},
      durationMs: 1,
      pleachVersion: '0.0.1-test',
    });
    const nodes = [
      {
        id: 'x',
        work: { prompt: 'build x' },
        accept: { smoke: 'same-cmd' },
        policy: { maxAttempts: 1 },
      },
      { id: 'y', work: { prompt: 'build y' }, policy: { maxAttempts: 1 } },
    ];
    const h = makeHarness({
      closed: new Map([
        ['x', 'sha-x'],
        ['y', 'sha-y'],
      ]),
      refs: { 'node/x': 'sha-x', 'node/y': 'sha-y' },
      receiptsSeed: { x: matching }, // y has no receipt — legacy close
    });
    const summary = await runPlan(plan(nodes), h.deps, OPTS);

    expect(summary.alreadyVerified).toEqual(['x', 'y']);
    expect(h.log.count('spawn:build')).toBe(0);
  });
});
