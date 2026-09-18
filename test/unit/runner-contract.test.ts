// ledger: D23 — the runner contract is the table. umbel's `wait --json` names
// one of nine reasons (contracts/runner.md on jahala/plotplot), and pleach must
// name and classify every one of them as the contract says. On 2026-09-18
// provider-error, file and pattern were not in pleach's reason union at all.
//
// test/fixtures/runner-reasons.jsonl is a verbatim copy of the contract's
// fixture, contracts/fixtures/runner/reasons.jsonl on jahala/plotplot: one
// {reason, exitCode, meaning, classification} object per line. The umbrella's
// seam test, contracts/test/runner.test.sh, compares the live copies: it reads
// the first `reason?: … ;` in src/loop/deps.ts and the `case '<reason>':` /
// `return '<class>';` lines of classifyWorkerReason in src/core/classify.ts by
// regex. This file applies the same regexes, so a refactor that would break the
// seam test breaks this one first.
//
// A reason the table lacks is the runner breaking the contract: it falls to
// terminal (never default-retry what cannot be named) and is journaled as
// `seam-violation` with the reason's text. That half runs the loop over the
// in-memory seams of test/loop/harness.ts, real implementations of the seam
// interfaces; it lives here because the claim is one table, read from both ends.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { classify, type WorkerReason } from '../../src/core/classify.ts';
import type { WorkerResult } from '../../src/loop/deps.ts';
import { runNode } from '../../src/loop/run-node.ts';
import { makeHarness, makeNode, stop } from '../loop/harness.ts';

interface Row {
  reason: string;
  exitCode: number;
  meaning: string;
  classification: string;
}

const FIXTURE = new URL('../fixtures/runner-reasons.jsonl', import.meta.url).pathname;
const DEPS = new URL('../../src/loop/deps.ts', import.meta.url).pathname;
const CLASSIFY = new URL('../../src/core/classify.ts', import.meta.url).pathname;

const ROWS: Row[] = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Row);

// The umbrella's read of the union: the first `reason?: … ;` in deps.ts, its
// quoted literals.
function unionReasons(): string[] {
  const m = readFileSync(DEPS, 'utf8').match(/reason\?:\s*([^;]+);/);
  if (m === null) return [];
  return [...(m[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((x) => x[1] ?? '');
}

// The umbrella's read of the classifier: each run of `case '<reason>'` lines
// takes the class of the `return '<class>'` line that follows it.
function classifierCases(): Map<string, string> {
  const out = new Map<string, string>();
  const m = readFileSync(CLASSIFY, 'utf8').match(/function classifyWorkerReason[\s\S]*?\n\}/);
  if (m === null) return out;
  let pending: string[] = [];
  for (const line of m[0].split('\n')) {
    const c = line.match(/case '([a-z-]+)'/);
    if (c !== null) {
      pending.push(c[1] ?? '');
      continue;
    }
    const r = line.match(/return '([a-z]+)'/);
    if (r !== null) {
      for (const p of pending) out.set(p, r[1] ?? '');
      pending = [];
    }
  }
  return out;
}

describe('the runner contract: nine reasons, each named and classified as its fixture says (D23)', () => {
  test('the vendored fixture is the contract’s nine rows', () => {
    expect(ROWS.map((r) => r.reason)).toEqual([
      'stop',
      'file',
      'pattern',
      'provider-error',
      'idle',
      'timeout',
      'dead',
      'input',
      'aborted',
    ]);
  });

  for (const row of ROWS) {
    test(`classify: ${row.reason} (exit ${row.exitCode}) is ${row.classification}`, () => {
      expect(classify({ kind: 'worker', reason: row.reason as WorkerReason })).toBe(
        row.classification as ReturnType<typeof classify>,
      );
    });
  }

  test('WorkerResult.reason in src/loop/deps.ts names exactly the fixture’s reasons', () => {
    expect(unionReasons().sort()).toEqual(ROWS.map((r) => r.reason).sort());
  });

  test('classifyWorkerReason lists a case for every fixture reason, answering its class', () => {
    const cases = classifierCases();
    const table = Object.fromEntries(ROWS.map((r) => [r.reason, cases.get(r.reason) ?? 'no case']));
    expect(table).toEqual(Object.fromEntries(ROWS.map((r) => [r.reason, r.classification])));
  });
});

describe('the loop over the contract (D23)', () => {
  const DEF = 60_000;
  const PROVIDER_TEXT = 'API Error: 529 {"type":"overloaded_error","message":"Overloaded"}';
  // What the umbel adapter hands over when a runner names a reason the contract
  // does not: it reads the reason as a string from the wait's JSON.
  const UNNAMED: string = 'wedged';

  test('provider-error is retried on the same tree, the provider’s text in the re-prompt', async () => {
    const provider: WorkerResult = {
      reason: 'provider-error' as WorkerReason,
      message: PROVIDER_TEXT,
      finalMessage: '',
      filesTouched: [],
      telemetry: {},
    };
    const h = makeHarness({
      changedByNode: { n: ['src/feature.ts'] },
      waitScript: (ctx) => (ctx.role === 'build' && ctx.spawnIndex === 0 ? provider : stop()),
    });

    const r = await runNode(makeNode({ id: 'n' }), ['base'], h.deps, { defaultTimeoutMs: DEF });

    expect(r.verdict.status).toBe('done');
    expect(r.verdict.attempts).toBe(2);
    expect(h.log.count('isolate', 'n')).toBe(1);
    const sends = h.log.of('send').filter((e) => e.node === 'n' && e.detail?.startsWith('build:'));
    expect(sends).toHaveLength(2);
    expect(sends[1]?.detail).toContain(PROVIDER_TEXT);
  });

  test('a reason the contract lacks is terminal and journaled as seam-violation with its text', async () => {
    expect(classify({ kind: 'worker', reason: UNNAMED as WorkerReason })).toBe('terminal');

    const unnamed: WorkerResult = {
      reason: UNNAMED as WorkerReason,
      finalMessage: '',
      filesTouched: [],
      telemetry: {},
    };
    const h = makeHarness({
      changedByNode: { n: ['src/feature.ts'] },
      waitScript: (ctx) => (ctx.role === 'build' ? unnamed : stop()),
    });

    // Two attempts allowed: a terminal end spends only the first.
    const r = await runNode(makeNode({ id: 'n' }), ['base'], h.deps, { defaultTimeoutMs: DEF });

    expect(r.verdict.status).toBe('failed');
    expect(r.verdict.attempts).toBe(1);
    expect(h.log.count('spawn:build', 'n')).toBe(1);
    const violations = h.journal.filter((e) => e.event === 'seam-violation');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      event: 'seam-violation',
      node: 'n',
      reason: UNNAMED,
      detail: 'umbel wait returned a reason contracts/runner.md does not name',
    });
  });
});
