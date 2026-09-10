// ledger: D17 — the builder's handback outlives the session. The final message
// a worker hands back is the one the garden's law asks for a dated Tried line
// in; umbel's kill removes the session, so until now it survived only in the
// provider's own transcript (jahala/pleach#66). Settle keeps it beside the
// receipt exactly the way D14 keeps a findings log: `<node>.handback.md`
// through the receipt store, one `gate-artifact` {node, gate: 'handback',
// path, sha256}, and the path named on the receipt file outside the envelope.
//
// Verbatim is the whole point. pleach keeps the message and reads nothing in
// it — no Tried line is parsed, no block is extracted (agents produce; code
// decides). And keeping is never a reason to lose a close: a store that cannot
// write journals `receipt-write-failed` and the node closes anyway, because the
// seal is already pinned in the commit trailer.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { canonicalJson, type Receipt, rehash, sha256Hex } from '../../src/core/receipt.ts';
import type { RunSummary, WorkerResult } from '../../src/loop/deps.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, type HarnessOpts, makeHarness, stop } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };
const HANDBACK_PATH = '/r/.git/pleach/receipts/x.handback.md';
const SMOKE = 'weeder check --strict --format sarif';

// A handback as a builder really writes one: prose, a fenced run of the tests,
// and the dated Tried line the loop page transcribes. Kept as-is — the fences
// and the trailing newline included.
const HANDBACK = [
  'Kept the final attempt handback beside the receipt (D17).',
  '',
  '```',
  'bun test test/loop/handback-kept.test.ts   7 pass 0 fail',
  '```',
  '',
  'Tried: 2026-09-10 kept the message; rejected reading its Tried line in pleach.',
  '',
].join('\n');

// A findings log, so the three kept artifacts can be seen not to collide.
const SARIF = `${JSON.stringify(
  { version: '2.1.0', runs: [{ tool: { driver: { name: 'weeder' } }, results: [] }] },
  null,
  2,
)}\n`;

const FRICTION_MONTH = `${JSON.stringify({ at: '2026-09-02T11:20:00Z', kind: 'retry' })}\n`;

function smokeThatPrints(stdout: string, exitCode = 0): HarnessOpts['execScript'] {
  return (argv) =>
    argv[0] === 'weeder'
      ? { output: `warming up\n${stdout}`, stdout, exitCode }
      : { output: '', exitCode: 0 };
}

// Every builder hands back the same message unless a test says otherwise; the
// auditor keeps the harness's own egress, so the two are never confusable.
function builderSays(message: string): HarnessOpts['waitScript'] {
  return (ctx) =>
    ctx.role === 'audit'
      ? stop({
          finalMessage: '```tend-audit-result\n{"verdicts":[{"check":"c","verdict":"pass"}]}\n```',
        })
      : stop({ finalMessage: message });
}

interface PlanShape {
  smoke?: string;
  audit?: boolean;
  maxAttempts?: number;
}

async function run(h: Harness, shape: PlanShape = {}): Promise<RunSummary> {
  return runPlan(
    PlanSchema.parse({
      goal: 'g',
      source: 'docs/tend2/nothing-is-lost.tend2.html',
      nodes: [
        {
          id: 'x',
          work: { prompt: 'build x' },
          accept: {
            ...(shape.smoke !== undefined ? { smoke: shape.smoke } : {}),
            ...(shape.audit === true
              ? { audit: { command: 'bash git-audit.sh c1', provider: 'codex' } }
              : {}),
          },
          policy: { maxAttempts: shape.maxAttempts ?? 1 },
        },
      ],
    }),
    h.deps,
    OPTS,
  );
}

function receiptOf(h: Harness): Receipt {
  const r = h.receipts.get('x');
  if (r === undefined) throw new Error('the settled node wrote no receipt');
  return r;
}

// The paths settle kept, beside `refs` and outside the hashed envelope. The
// handback is the third kind; the cast is the test asking for what the claim
// says the receipt must name.
type KeptPaths = { sarif?: string; friction?: string; handback?: string };

function keptPaths(h: Harness): KeptPaths {
  return (receiptOf(h).artifacts ?? {}) as KeptPaths;
}

function gateArtifactEvents(h: Harness): Record<string, unknown>[] {
  return h.journal.filter((e) => e.event === 'gate-artifact');
}

function handbackEvents(h: Harness): Record<string, unknown>[] {
  return gateArtifactEvents(h).filter((e) => e.gate === 'handback');
}

// Sequence number of the write that kept THIS path (log.first matches on kind
// and node alone, and a node may keep three files).
function keptAt(h: Harness, path: string): number {
  const e = h.log.events.find((ev) => ev.kind === 'receipt.artifact' && ev.detail === path);
  return e ? e.at : -1;
}

describe('the handback is kept beside the receipt (D17)', () => {
  test('a closed node keeps the final message verbatim as <node>.handback.md', async () => {
    const h = makeHarness({ waitScript: builderSays(HANDBACK) });
    const summary = await run(h);
    expect(summary.closed).toEqual(['x']);

    expect(keptPaths(h).handback).toBe(HANDBACK_PATH);
    // Byte-for-byte: the fences, the blank lines and the Tried line as written.
    expect(h.artifacts.get(HANDBACK_PATH)).toBe(HANDBACK);
    // Kept before the receipt that names it — a path on a receipt whose file
    // was never written is a claim about nothing.
    expect(keptAt(h, HANDBACK_PATH)).toBeGreaterThan(-1);
    expect(keptAt(h, HANDBACK_PATH)).toBeLessThan(h.log.first('receipt.write', 'x'));
    expect(keptAt(h, HANDBACK_PATH)).toBeLessThan(h.log.first('dispose-start', 'x'));
  });

  test('the journal records one gate-artifact {node, gate: handback, path, sha256}', async () => {
    const h = makeHarness({ waitScript: builderSays(HANDBACK) });
    await run(h);

    expect(handbackEvents(h)).toEqual([
      {
        event: 'gate-artifact',
        node: 'x',
        gate: 'handback',
        path: HANDBACK_PATH,
        sha256: sha256Hex(HANDBACK),
      },
    ]);
  });

  test('the receipt names it outside the envelope — the seal is untouched', async () => {
    const h = makeHarness({ waitScript: builderSays(HANDBACK) });
    await run(h);
    const receipt = receiptOf(h);

    expect(keptPaths(h).handback).toBe(HANDBACK_PATH);
    expect(rehash(receipt)).toBe(true);
    // A settled fact, like refs: the file lands after the freeze. And nothing
    // in the message is interpreted — the envelope holds no word of it.
    const sealed = canonicalJson({ facts: receipt.facts, derived: receipt.derived });
    expect(sealed).not.toContain('.handback.md');
    expect(sealed).not.toContain('Tried:');
    // Nor does the journal relay the message: a path and a hash, nothing else.
    for (const event of h.journal) {
      expect(JSON.stringify(event)).not.toContain('Tried:');
    }
  });

  test('a quarantined node keeps its handback too — it says what the worker was doing', async () => {
    const h = makeHarness({
      waitScript: builderSays(HANDBACK),
      execScript: smokeThatPrints('bun test\n\n 1 fail\n', 1),
    });
    const summary = await run(h, { smoke: SMOKE });
    expect(summary.failed).toEqual(['x']);

    expect(h.artifacts.get(HANDBACK_PATH)).toBe(HANDBACK);
    expect(keptPaths(h).handback).toBe(HANDBACK_PATH);
    expect(handbackEvents(h)).toHaveLength(1);
    expect(keptAt(h, HANDBACK_PATH)).toBeLessThan(h.log.first('dispose-start', 'x'));
    // The kept path joins the quarantine refs; neither write clobbers the other.
    expect(receiptOf(h).refs?.quarantineBranch).toBe('quarantine/x');
  });

  test('a halted node keeps what the worker managed to say (D16 settle)', async () => {
    const controller = new AbortController();
    const partial = 'Half way: the red test is written, the fix is not.\n';
    const h = makeHarness({
      changedByNode: { x: ['src/wip.ts'] },
      waitScript: (ctx) => {
        if (ctx.role !== 'build') return stop();
        controller.abort();
        return new Promise<WorkerResult>((resolve) => {
          setTimeout(() => resolve(stop({ finalMessage: partial, reason: 'aborted' })), 0);
        });
      },
    });

    const summary = await runPlan(
      PlanSchema.parse({
        goal: 'g',
        source: 'docs/tend2/nothing-is-lost.tend2.html',
        nodes: [{ id: 'x', work: { prompt: 'build x' }, policy: { maxAttempts: 2 } }],
      }),
      h.deps,
      { ...OPTS, signal: controller.signal },
    );
    expect(summary.aborted).toEqual(['x']);

    expect(h.artifacts.get(HANDBACK_PATH)).toBe(partial);
    expect(keptPaths(h).handback).toBe(HANDBACK_PATH);
    expect(receiptOf(h).refs?.quarantineBranch).toBe('quarantine/x');
  });

  test('the FINAL attempt is the one kept, once', async () => {
    const first = 'Attempt 1: the smoke is red and I do not know why yet.\n';
    const last = 'Attempt 2: fixed the import; smoke green.\n\nTried: 2026-09-10 fixed it.\n';
    let smokeRuns = 0;
    const h = makeHarness({
      waitScript: (ctx) =>
        ctx.role === 'build' ? stop({ finalMessage: ctx.spawnIndex === 0 ? first : last }) : stop(),
      execScript: (argv) => {
        if (argv[0] !== 'weeder') return { output: '', exitCode: 0 };
        smokeRuns += 1;
        return { output: 'smoke\n', exitCode: smokeRuns === 1 ? 1 : 0 };
      },
    });
    const summary = await run(h, { smoke: SMOKE, maxAttempts: 2 });
    expect(summary.closed).toEqual(['x']);
    expect(smokeRuns).toBe(2);

    expect(handbackEvents(h)).toHaveLength(1);
    expect(h.artifacts.get(HANDBACK_PATH)).toBe(last);
    expect(handbackEvents(h)[0]?.sha256).toBe(sha256Hex(last));
  });

  test("the builder's message is kept, never the auditor's egress", async () => {
    const h = makeHarness({ waitScript: builderSays(HANDBACK) });
    const summary = await run(h, { audit: true });
    expect(summary.closed).toEqual(['x']);

    expect(h.log.count('spawn:audit', 'x')).toBe(1);
    expect(h.artifacts.get(HANDBACK_PATH)).toBe(HANDBACK);
    expect(h.artifacts.get(HANDBACK_PATH)).not.toContain('tend-audit-result');
  });

  test('kept beside the other two, one event each, no collision', async () => {
    const h = makeHarness({
      waitScript: builderSays(HANDBACK),
      execScript: smokeThatPrints(SARIF),
      plotplotByNode: { x: { '.plotplot/friction/2026-09.jsonl': FRICTION_MONTH } },
    });
    await run(h, { smoke: SMOKE });

    expect(keptPaths(h)).toEqual({
      sarif: '/r/.git/pleach/receipts/x.sarif',
      friction: '/r/.git/pleach/receipts/x.friction.jsonl',
      handback: HANDBACK_PATH,
    });
    expect(h.artifacts.get('/r/.git/pleach/receipts/x.sarif')).toBe(SARIF);
    expect(h.artifacts.get('/r/.git/pleach/receipts/x.friction.jsonl')).toBe(FRICTION_MONTH);
    expect(h.artifacts.get(HANDBACK_PATH)).toBe(HANDBACK);
    expect(
      gateArtifactEvents(h)
        .map((e) => e.gate)
        .sort(),
    ).toEqual(['friction', 'handback', 'smoke']);
  });

  test('an empty handback keeps nothing, and forgets what an earlier close left', async () => {
    const h = makeHarness({
      // The first close hands back a message; the second (the same node id run
      // again) hands back nothing at all.
      waitScript: (ctx) =>
        ctx.role === 'build'
          ? stop({ finalMessage: ctx.spawnIndex === 0 ? HANDBACK : '' })
          : stop(),
    });

    expect((await run(h)).closed).toEqual(['x']);
    expect(h.artifacts.get(HANDBACK_PATH)).toBe(HANDBACK);

    expect((await run(h)).closed).toEqual(['x']);
    // The artifact name is the node's, not the close's: left alone, the first
    // close's message would be read as this one's.
    expect(h.artifacts.has(HANDBACK_PATH)).toBe(false);
    expect(keptPaths(h).handback).toBeUndefined();
    expect(handbackEvents(h)).toHaveLength(1);
  });

  test('a store that cannot write journals receipt-write-failed and the close stands', async () => {
    const h = makeHarness({
      waitScript: builderSays(HANDBACK),
      writeArtifactThrows: new Error('read-only file system (test)'),
    });
    const summary = await run(h);

    // The close is already pinned in git: branch, receipt, closed event.
    expect(summary.closed).toEqual(['x']);
    expect(h.git.refs.get('node/x')).toBeDefined();
    expect(h.journal.filter((e) => e.event === 'closed' && e.node === 'x')).toHaveLength(1);
    expect(receiptOf(h).sha256).toBeDefined();

    // Nothing was kept, so nothing is claimed — and the miss is named.
    expect(handbackEvents(h)).toEqual([]);
    expect(keptPaths(h).handback).toBeUndefined();
    const failures = h.journal.filter((e) => e.event === 'receipt-write-failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.node).toBe('x');
    expect(String(failures[0]?.detail)).toContain('read-only file system (test)');
  });
});
