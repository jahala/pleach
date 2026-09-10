// ledger: D14 — the smoke gate's findings log outlives the worktree. The seal
// already carries `gates[].artifactSha` (test/loop/gate-artifact-receipt.ts);
// this is the other half: at settle, BEFORE the tree is disposed, the very
// bytes that hash to it are written beside the receipt, the receipt file names
// the path outside the envelope (`artifacts.sarif`, a sibling of `refs` —
// settled after the freeze, so it can never be inside), and the journal records
// one `gate-artifact` {node, gate, path, sha256}.
//
// Ordering is the whole claim: after dispose there is no log to keep. And a
// store that cannot write is a journal line, never a failed close — the receipt
// hash is already pinned in the commit trailer, exactly like the receipt file's
// own write (`receipt-write-failed`).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PlanSchema } from '../../src/core/plan.ts';
import { canonicalJson, type Receipt, rehash, sha256Hex } from '../../src/core/receipt.ts';
import type { RunSummary } from '../../src/loop/deps.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, type HarnessOpts, makeHarness } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };
const SMOKE = 'weeder check --strict --format sarif';
const SARIF_PATH = '/r/.git/pleach/receipts/x.sarif';

// A findings log as a real gate prints it — pretty-printed, trailing newline.
// The kept bytes are these, verbatim: never a re-serialization of the parse.
function sarif(ruleId: string): string {
  return `${JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'weeder', rules: [{ id: ruleId }] } },
          results: [
            {
              ruleId,
              level: 'error',
              message: { text: 'a test passed without the change it covers' },
              suppressions: [{ kind: 'external', justification: 'agent waved it through' }],
            },
          ],
        },
      ],
    },
    null,
    2,
  )}\n`;
}

const LOG = sarif('B1');
const PLAIN = 'bun test\n\n 41 pass\n 0 fail\n';

// A gate that printed a log on stdout while something else spoke on stderr:
// `output` interleaves both, so only the child's own stream can be kept.
function smokeThatPrints(stdout: string, exitCode = 0): HarnessOpts['execScript'] {
  return (argv) =>
    argv[0] === 'weeder'
      ? { output: `warming up\n${stdout}rules: 1\n`, stdout, exitCode }
      : { output: '', exitCode: 0 };
}

async function run(h: Harness, maxAttempts = 1): Promise<RunSummary> {
  return runPlan(
    PlanSchema.parse({
      goal: 'g',
      source: 'docs/tend2/gate-artifacts.tend2.html',
      nodes: [
        {
          id: 'x',
          work: { prompt: 'build x' },
          accept: { smoke: SMOKE },
          policy: { maxAttempts },
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

// The receipt file's settled sidecar: the paths settle kept, beside `refs` and
// outside the hashed envelope.
function keptPaths(h: Harness): { sarif?: string } {
  return (receiptOf(h) as Receipt & { artifacts?: { sarif?: string } }).artifacts ?? {};
}

function sealedArtifactSha(h: Harness): string | undefined {
  return receiptOf(h).facts.gates.find((g) => g.gate === 'smoke')?.artifactSha;
}

// Every close also keeps the worker's handback (D17), so a settle's events are
// read by kind: the claim here is the gate's own findings log. The handback's
// own claim is test/loop/handback-kept.test.ts.
function gateArtifactEvents(h: Harness, gate = 'smoke'): Record<string, unknown>[] {
  return h.journal.filter((e) => e.event === 'gate-artifact' && e.gate === gate);
}

// Whether the log was kept, by the path the store returns for it.
function keptSarif(h: Harness): string | undefined {
  return h.artifacts.get(SARIF_PATH);
}

describe('gate artifacts — the kept log at settle (D14)', () => {
  test('the log is written before the tree goes, and the kept bytes are the sealed ones', async () => {
    const h = makeHarness({ execScript: smokeThatPrints(LOG) });
    const summary = await run(h);
    expect(summary.closed).toEqual(['x']);

    const written = h.log.first('receipt.artifact', 'x');
    expect(written).toBeGreaterThan(-1);
    // After dispose there is nothing left to read: the write happens while the
    // worktree still exists, and before anything can observe the node closed.
    expect(written).toBeLessThan(h.log.first('dispose-start', 'x'));

    const path = keptPaths(h).sarif;
    expect(path).toBe(SARIF_PATH);
    const bytes = h.artifacts.get(path ?? '');
    expect(bytes).toBe(LOG);
    // One hash, two carriers: the seal cites the file, the file answers to it.
    expect(sha256Hex(bytes ?? '')).toBe(sealedArtifactSha(h) as string);
  });

  test('the receipt names the file outside the envelope — the seal is untouched', async () => {
    const h = makeHarness({ execScript: smokeThatPrints(LOG) });
    await run(h);
    const receipt = receiptOf(h);

    expect(keptPaths(h).sarif).toBeDefined();
    expect(rehash(receipt)).toBe(true);
    // A path is a settled fact, not a frozen one (it lands after the freeze,
    // like refs). Inside the envelope it would be a second, unverifiable claim.
    expect(canonicalJson({ facts: receipt.facts, derived: receipt.derived })).not.toContain(
      '.sarif',
    );
    expect(receipt.refs?.diffRef).toBe(h.git.refs.get('node/x') as string);
  });

  test('the journal records one gate-artifact {node, gate, path, sha256}', async () => {
    const h = makeHarness({ execScript: smokeThatPrints(LOG) });
    await run(h);

    expect(gateArtifactEvents(h)).toEqual([
      {
        event: 'gate-artifact',
        node: 'x',
        gate: 'smoke',
        path: '/r/.git/pleach/receipts/x.sarif',
        sha256: sha256Hex(LOG),
      },
    ]);
  });

  test('a quarantined node keeps its log too — the failing gate wrote the log that says why', async () => {
    const h = makeHarness({ execScript: smokeThatPrints(LOG, 1) });
    const summary = await run(h);
    expect(summary.failed).toEqual(['x']);

    expect(h.log.first('receipt.artifact', 'x')).toBeGreaterThan(-1);
    expect(h.log.first('receipt.artifact', 'x')).toBeLessThan(h.log.first('dispose-start', 'x'));
    expect(h.artifacts.get('/r/.git/pleach/receipts/x.sarif')).toBe(LOG);
    expect(gateArtifactEvents(h)).toHaveLength(1);
    // The kept path joins the quarantine refs; neither write clobbers the other.
    const receipt = receiptOf(h);
    expect(keptPaths(h).sarif).toBe('/r/.git/pleach/receipts/x.sarif');
    expect(receipt.refs?.quarantineBranch).toBe('quarantine/x');
    expect(sha256Hex(LOG)).toBe(sealedArtifactSha(h) as string);
  });

  test('a retried node keeps the final attempt log, once — the sealed one', async () => {
    const first = sarif('A1');
    const last = sarif('Z9');
    let smokeRuns = 0;
    const h = makeHarness({
      execScript: (argv) => {
        if (argv[0] !== 'weeder') return { output: '', exitCode: 0 };
        smokeRuns += 1;
        const stdout = smokeRuns === 1 ? first : last;
        return { output: `warming up\n${stdout}`, stdout, exitCode: smokeRuns === 1 ? 1 : 0 };
      },
    });
    const summary = await run(h, 2);
    expect(summary.closed).toEqual(['x']);
    expect(smokeRuns).toBe(2);

    expect(gateArtifactEvents(h)).toHaveLength(1);
    expect(h.artifacts.get('/r/.git/pleach/receipts/x.sarif')).toBe(last);
    expect(sealedArtifactSha(h)).toBe(sha256Hex(last));
  });

  test('stdout that is not a findings log keeps nothing', async () => {
    for (const stdout of [PLAIN, '']) {
      const h = makeHarness({ execScript: smokeThatPrints(stdout) });
      await run(h);
      expect(keptSarif(h)).toBeUndefined();
      expect(gateArtifactEvents(h)).toEqual([]);
      expect(keptPaths(h).sarif).toBeUndefined();
      expect(h.log.events.some((e) => e.detail === SARIF_PATH)).toBe(false);
    }
  });

  test('a store that cannot write journals receipt-write-failed and the close stands', async () => {
    const h = makeHarness({
      execScript: smokeThatPrints(LOG),
      writeArtifactThrows: new Error('read-only file system (test)'),
    });
    const summary = await run(h);

    // The close is already pinned in git: branch, receipt, closed event.
    expect(summary.closed).toEqual(['x']);
    expect(h.git.refs.get('node/x')).toBeDefined();
    expect(h.journal.filter((e) => e.event === 'closed' && e.node === 'x')).toHaveLength(1);
    expect(receiptOf(h).sha256).toBeDefined();

    // Nothing was kept, so nothing is claimed — and every miss is named: one
    // line per artifact this close would have kept (the log, and the worker's
    // handback), because a failure of one is never allowed to hide the other.
    expect(gateArtifactEvents(h)).toEqual([]);
    expect(keptPaths(h).sarif).toBeUndefined();
    expect(h.artifacts.size).toBe(0);
    const failures = h.journal.filter((e) => e.event === 'receipt-write-failed');
    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      expect(String(failure.detail)).toContain('read-only file system (test)');
      expect(failure.node).toBe('x');
    }
  });
});

// The published read surfaces the kept file appears on. Both are part of the
// claim: an event nobody documented is not a stable journal, and a receipt
// field the other two repos never heard of is a silent contract change.
const doc = (rel: string) =>
  readFileSync(new URL(`../../${rel}`, import.meta.url).pathname, 'utf8');

describe('gate artifacts — the documented surface (D14)', () => {
  test('docs/journal.md documents gate-artifact with the fields it appends', () => {
    const row = doc('docs/journal.md')
      .split('\n')
      .find((line) => line.startsWith('| `gate-artifact`'));
    expect(row).toBeDefined();
    for (const field of ['node', 'gate', 'path', 'sha256']) {
      expect(row).toContain(`\`${field}\``);
    }
  });

  test('docs/contract/CHANGES.md notes the additive receipt field', () => {
    const entry = doc('docs/contract/CHANGES.md')
      .split(/\n(?=- )/)
      .find((e) => e.includes('artifactSha'));
    expect(entry).toBeDefined();
    expect(entry).toMatch(/\b2026-\d\d-\d\d\b/);
    expect(entry).toMatch(/additive|backward-compatible/i);
  });
});
