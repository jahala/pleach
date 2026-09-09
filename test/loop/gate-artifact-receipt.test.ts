// ledger: D14 — the smoke gate's findings log, bound to the sealed receipt by
// one hash. When the smoke is `weeder check --strict --format sarif` its stdout
// is a SARIF 2.1.0 log whose `suppressions` are the only record of what an agent
// waved through in that node; `gates[].artifactSha` is the sha256 of those bytes
// — the same hash the umbrella's receipt predicate (`weeder.sarif.sha256`) cites
// and the same bytes settle keeps beside the receipt.
//
// The two halves of the claim: a gate whose stdout IS a log gains the hash, and
// a gate whose stdout is anything else leaves the receipt byte-identical to what
// it was before this field existed. The second half is what makes the field
// additive — every receipt already on disk must still hash to its own seal.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { canonicalJson, receiptHash, rehash, sha256Hex } from '../../src/core/receipt.ts';
import { verifyReceipt } from '../../src/loop/receipt-verify.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, makeHarness } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };

const SMOKE = 'weeder check --strict --format sarif';
const SETUP = 'weeder install --format sarif';

// A findings log as a real gate prints it: pretty-printed, $schema first, and a
// trailing newline. The hash is over these bytes verbatim — not over a
// re-serialization of the parsed value.
const SARIF = `${JSON.stringify(
  {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'weeder', rules: [{ id: 'B1' }] } },
        results: [
          {
            ruleId: 'B1',
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

// The same document under a version this code has not read the spec for.
const SARIF_2_0 = SARIF.replace('"version": "2.1.0"', '"version": "2.0.0"');

const PLAIN = 'bun test\n\n 41 pass\n 0 fail\n';

type Script = (argv: readonly string[]) => { output: string; stdout?: string; exitCode: number };

// One node, one smoke gate, closed. `script` decides what each gate's command
// wrote; everything else is the harness's ordinary green path.
async function closedOn(script: Script, node: { setup?: string } = {}): Promise<Harness> {
  const h = makeHarness({ execScript: (argv) => script(argv) });
  await runPlan(
    PlanSchema.parse({
      goal: 'g',
      source: 's',
      nodes: [
        {
          id: 'x',
          work: { prompt: 'build x' },
          ...(node.setup !== undefined ? { setup: node.setup } : {}),
          accept: { smoke: SMOKE },
          policy: { maxAttempts: 1 },
        },
      ],
    }),
    h.deps,
    OPTS,
  );
  return h;
}

function receiptOf(h: Harness) {
  const r = h.receipts.get('x');
  if (r === undefined) throw new Error('the closed node wrote no receipt');
  return r;
}

function smokeGate(h: Harness) {
  const gate = receiptOf(h).facts.gates.find((g) => g.gate === 'smoke');
  if (gate === undefined) throw new Error('the receipt records no smoke gate');
  return gate;
}

// A gate that printed a log on stdout while something else spoke on stderr —
// `output` interleaves both, so only `stdout` can be hashed.
const sarifSmoke: Script = (argv) =>
  argv[0] === 'weeder' && argv[1] === 'check'
    ? { output: `warming up\n${SARIF}rules: 1\n`, stdout: SARIF, exitCode: 0 }
    : { output: '', exitCode: 0 };

describe('gate artifacts — the smoke log in the sealed receipt (D14)', () => {
  test('a SARIF smoke log is hashed onto the gate record — the stdout bytes, not the interleaved stream', async () => {
    const h = await closedOn(sarifSmoke);
    expect(smokeGate(h).artifactSha).toBe(sha256Hex(SARIF));
  });

  test('the seal covers artifactSha: `pleach receipt` passes untouched and catches an edited hash', async () => {
    const h = await closedOn(sarifSmoke);
    const receipt = receiptOf(h);
    expect(rehash(receipt)).toBe(true);
    // Inside the envelope, not beside it: the hash is one of the bytes the seal
    // is taken over, so no one can swap the artifact and keep the receipt.
    expect(canonicalJson({ facts: receipt.facts, derived: receipt.derived })).toContain(
      sha256Hex(SARIF),
    );
    expect((await verifyReceipt('x', h.deps, '/r')).outcome).toBe('pass');

    // Swap the artifact this receipt claims to have kept, leaving every other
    // fact alone. If the hash were outside the envelope this would go unnoticed.
    const forged = {
      ...receipt,
      facts: {
        ...receipt.facts,
        gates: receipt.facts.gates.map((g) =>
          g.gate === 'smoke' ? { ...g, artifactSha: sha256Hex('a quieter log') } : g,
        ),
      },
    };
    expect(rehash(forged)).toBe(false);
    h.receipts.set('x', forged);
    expect((await verifyReceipt('x', h.deps, '/r')).outcome).toBe('tampered');
  });

  test('stdout that is not a SARIF 2.1.0 log keeps nothing — the gate ladder is byte-identical to today', async () => {
    for (const stdout of [PLAIN, SARIF_2_0, '']) {
      const h = await closedOn((argv) =>
        argv[0] === 'weeder' && argv[1] === 'check'
          ? { output: `warming up\n${stdout}`, stdout, exitCode: 0 }
          : { output: '', exitCode: 0 },
      );
      expect(smokeGate(h).artifactSha).toBeUndefined();
      expect(canonicalJson(receiptOf(h).facts.gates)).toBe(
        '[{"exitCode":0,"gate":"marker"},{"exitCode":0,"gate":"hygiene"},{"exitCode":0,"gate":"smoke"}]',
      );
      expect((await verifyReceipt('x', h.deps, '/r')).outcome).toBe('pass');
    }
  });

  test('the field is additive: a gate record carrying no artifact hashes as it always did', async () => {
    const receipt = receiptOf(await closedOn(() => ({ output: PLAIN, exitCode: 0 })));
    // What the minted facts would be if the field were written as absent rather
    // than omitted. canonicalJson drops undefined, so the seal is the same one
    // every receipt already on disk carries.
    const facts = {
      ...receipt.facts,
      gates: receipt.facts.gates.map((g) => ({ ...g, artifactSha: undefined })),
    };
    expect(receiptHash(facts, receipt.derived)).toBe(receipt.sha256);
  });

  test('only the smoke gate keeps a findings log — a setup gate printing SARIF keeps nothing', async () => {
    const h = await closedOn(
      (argv) =>
        argv[1] === 'install'
          ? { output: SARIF, stdout: SARIF, exitCode: 0 }
          : { output: PLAIN, stdout: PLAIN, exitCode: 0 },
      { setup: SETUP },
    );
    expect(receiptOf(h).facts.gates.filter((g) => g.artifactSha !== undefined)).toEqual([]);
  });
});
