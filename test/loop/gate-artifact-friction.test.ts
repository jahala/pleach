// ledger: D14 — the worktree's friction journal outlives the tree. weeder and
// tend2 write `.plotplot/friction/<yyyy-mm>.jsonl` inside the worktree while a
// node runs; under pleach that tree is disposed and the record goes with it.
// So at settle, before dispose, whatever the isolate seam reads back out of
// that directory is kept beside the receipt as `<node>.friction.jsonl`, with
// its own `gate-artifact` event and its own name on the receipt file.
//
// It is never delivery: ga.collect already sets `.plotplot/friction/` aside
// before staging, so the file is kept exactly BECAUSE it was not committed —
// both halves are asserted here, because either alone is a false green (a
// staged journal is a leak; a set-aside one nobody keeps is the loss D14 names).
//
// Unlike the SARIF log there is no gate hash to cite: the journal is read at
// settle, not produced by a gate, so the event's sha256 is over the kept bytes
// and the sealed envelope is untouched.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import {
  canonicalJson,
  type Receipt,
  receiptPrefix,
  rehash,
  sha256Hex,
} from '../../src/core/receipt.ts';
import type { RunSummary } from '../../src/loop/deps.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, type HarnessOpts, makeHarness } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };
const SMOKE = 'weeder check --strict --format sarif';
const RECEIPTS = '/r/.git/pleach/receipts';

// Two months of journal, plus the ledger's own bookkeeping beside them: only
// the month files are the journal, and only in name order.
const AUG = `${JSON.stringify({ at: '2026-08-30T09:00:00Z', kind: 'reread', file: 'src/loop/run-plan.ts' })}\n`;
const SEP = `${JSON.stringify({ at: '2026-09-02T11:20:00Z', kind: 'retry', file: 'src/seams/isolate.ts' })}\n`;
const JOURNAL: Record<string, string> = {
  // Written out of name order on purpose — the kept bytes are sorted, not seen.
  '.plotplot/friction/2026-09.jsonl': SEP,
  '.plotplot/friction/2026-08.jsonl': AUG,
  '.plotplot/friction/state/cursor.jsonl': '{"seen":41}\n',
  '.plotplot/friction/hotspots.json': '{"src/loop/run-plan.ts":3}\n',
};
const KEPT = AUG + SEP;

// A findings log, so the two kept artifacts can be seen not to collide.
const SARIF = `${JSON.stringify(
  {
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'weeder' } }, results: [] }],
  },
  null,
  2,
)}\n`;

function smokeThatPrints(stdout: string, exitCode = 0): HarnessOpts['execScript'] {
  return (argv) =>
    argv[0] === 'weeder'
      ? { output: `warming up\n${stdout}`, stdout, exitCode }
      : { output: '', exitCode: 0 };
}

async function run(h: Harness): Promise<RunSummary> {
  return runPlan(
    PlanSchema.parse({
      goal: 'g',
      source: 'docs/tend2/gate-artifacts.tend2.html',
      nodes: [
        {
          id: 'x',
          work: { prompt: 'build x' },
          accept: { smoke: SMOKE },
          policy: { maxAttempts: 1 },
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

// Where this close's files went (D17): a node id runs again, so what a close
// kept is filed under that close's own receipt hash — the un-prefixed name is
// only whatever closed last.
function keptPath(h: Harness, suffix: string): string {
  return `${RECEIPTS}/x.${receiptPrefix(receiptOf(h).sha256)}${suffix}`;
}

function frictionPath(h: Harness): string {
  return keptPath(h, '.friction.jsonl');
}

function keptPaths(h: Harness): { sarif?: string; friction?: string } {
  return receiptOf(h).artifacts ?? {};
}

// Every close also keeps the worker's handback (D17), so a settle's events are
// read by kind: the claim here is the tree's own journal. The handback's own
// claim is test/loop/handback-kept.test.ts.
function gateArtifactEvents(h: Harness, gate = 'friction'): Record<string, unknown>[] {
  return h.journal.filter((e) => e.event === 'gate-artifact' && e.gate === gate);
}

describe('gate artifacts — the worktree friction journal at settle (D14)', () => {
  test('the journal is kept as <node>.friction.jsonl, months in name order, before dispose', async () => {
    const h = makeHarness({ plotplotByNode: { x: JOURNAL } });
    const summary = await run(h);
    expect(summary.closed).toEqual(['x']);

    // Read and written while the tree is still there — after dispose the
    // directory is gone and there is nothing left to keep.
    const written = h.log.first('receipt.artifact', 'x');
    expect(written).toBeGreaterThan(-1);
    expect(written).toBeLessThan(h.log.first('dispose-start', 'x'));

    expect(keptPaths(h).friction).toBe(frictionPath(h));
    // The month files concatenated in name order, verbatim: the ledger's own
    // state and hotspots are not the journal, and nothing is re-serialized.
    expect(h.artifacts.get(frictionPath(h))).toBe(KEPT);
  });

  test('the journal carries its own gate-artifact event, hashed over the kept bytes', async () => {
    const h = makeHarness({ plotplotByNode: { x: JOURNAL } });
    await run(h);

    expect(gateArtifactEvents(h)).toEqual([
      {
        event: 'gate-artifact',
        node: 'x',
        gate: 'friction',
        path: frictionPath(h),
        sha256: sha256Hex(KEPT),
      },
    ]);
  });

  test('the receipt names it outside the envelope — the seal is untouched', async () => {
    const h = makeHarness({ plotplotByNode: { x: JOURNAL } });
    await run(h);
    const receipt = receiptOf(h);

    expect(keptPaths(h).friction).toBe(frictionPath(h));
    expect(rehash(receipt)).toBe(true);
    // A settled fact, like refs: the journal is read after the freeze, so a
    // claim about it inside the hashed envelope could never have been made.
    expect(canonicalJson({ facts: receipt.facts, derived: receipt.derived })).not.toContain(
      'friction',
    );
  });

  test('what is kept is what collection set aside — never staged, and not lost either', async () => {
    // The worker's manifest names the journal it wrote, as it really does.
    const h = makeHarness({
      changedByNode: { x: ['work.out', '.plotplot/friction/2026-09.jsonl'] },
      stagedNumstatByNode: { x: [{ file: 'work.out', added: 1, deleted: 0 }] },
      plotplotByNode: { x: JOURNAL },
    });
    const summary = await run(h);
    expect(summary.closed).toEqual(['x']);

    const setAside = h.journal.filter((e) => e.event === 'set-aside' && e.node === 'x');
    expect(setAside).toHaveLength(1);
    expect(setAside[0]?.paths).toEqual(['.plotplot/friction/2026-09.jsonl']);
    // Staging saw the delivery and nothing else — the journal is kept beside
    // the receipt precisely because it never entered the verified commit.
    for (const staged of h.log.of('stage')) {
      expect(staged.detail).not.toContain('.plotplot/friction');
    }
    expect(h.artifacts.get(frictionPath(h))).toBe(KEPT);
  });

  test('a findings log and a friction journal are kept side by side, one event each', async () => {
    const h = makeHarness({
      execScript: smokeThatPrints(SARIF),
      plotplotByNode: { x: JOURNAL },
    });
    await run(h);

    expect(h.artifacts.get(keptPath(h, '.sarif'))).toBe(SARIF);
    expect(h.artifacts.get(frictionPath(h))).toBe(KEPT);
    expect(keptPaths(h).sarif).toBe(keptPath(h, '.sarif'));
    expect(keptPaths(h).friction).toBe(frictionPath(h));
    expect(gateArtifactEvents(h, 'smoke').map((e) => [e.gate, e.sha256])).toEqual([
      ['smoke', sha256Hex(SARIF)],
    ]);
    expect(gateArtifactEvents(h).map((e) => [e.gate, e.sha256])).toEqual([
      ['friction', sha256Hex(KEPT)],
    ]);
  });

  test('a quarantined node keeps its journal too — the friction is why it failed', async () => {
    const h = makeHarness({
      execScript: smokeThatPrints('bun test\n\n 1 fail\n', 1),
      plotplotByNode: { x: JOURNAL },
    });
    const summary = await run(h);
    expect(summary.failed).toEqual(['x']);

    expect(h.log.first('receipt.artifact', 'x')).toBeLessThan(h.log.first('dispose-start', 'x'));
    expect(h.artifacts.get(frictionPath(h))).toBe(KEPT);
    expect(keptPaths(h).friction).toBe(frictionPath(h));
    // The kept path joins the quarantine refs; neither write clobbers the other.
    expect(receiptOf(h).refs?.quarantineBranch).toBe('quarantine/x');
  });

  test('no journal in the tree keeps nothing and claims nothing', async () => {
    for (const plotplot of [
      undefined,
      // The ledger's state without a month file is not a journal.
      { '.plotplot/friction/state/cursor.jsonl': '{"seen":0}\n' },
    ]) {
      const h = makeHarness(plotplot === undefined ? {} : { plotplotByNode: { x: plotplot } });
      const summary = await run(h);
      expect(summary.closed).toEqual(['x']);
      expect(h.artifacts.has(frictionPath(h))).toBe(false);
      expect(gateArtifactEvents(h)).toEqual([]);
      expect(keptPaths(h).friction).toBeUndefined();
    }
  });

  test('a store that cannot write journals receipt-write-failed and the close stands', async () => {
    const h = makeHarness({
      plotplotByNode: { x: JOURNAL },
      writeArtifactThrows: new Error('read-only file system (test)'),
    });
    const summary = await run(h);

    expect(summary.closed).toEqual(['x']);
    expect(h.git.refs.get('node/x')).toBeDefined();
    expect(gateArtifactEvents(h)).toEqual([]);
    expect(h.artifacts.size).toBe(0);
    expect(keptPaths(h).friction).toBeUndefined();
    // One line per artifact this close would have kept (the tree's journal,
    // and the worker's handback): a failure of one never hides the other.
    const failures = h.journal.filter((e) => e.event === 'receipt-write-failed');
    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      expect(failure.node).toBe('x');
      expect(String(failure.detail)).toContain('read-only file system (test)');
    }
  });
});
