/**
 * E2E: a gate's findings log outlives the tree (ledger D14) through the real
 * CLI, real git and a real smoke process.
 *
 * A `{command}` node needs no runner, so this is pleach's own ladder end to
 * end: the smoke prints a SARIF 2.1.0 log to stdout (and noise to stderr), the
 * gate seals ONE sha256 of the stdout bytes into the receipt, and settle
 * writes those bytes beside the receipt before the worktree is disposed. The
 * file answers the seal, `pleach receipt` still verifies, and the journal says
 * where the file went. A smoke that prints anything else keeps nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Receipt } from '../../src/core/receipt.ts';
import { createRepo } from '../support/git-repo.ts';
import { ownFields } from '../support/journal.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const SARIF_SMOKE = join(import.meta.dir, '../fixtures/sarif-smoke.sh');
const PLAIN_SMOKE = join(import.meta.dir, '../fixtures/plain-smoke.sh');
const SARIF_FIXTURE = join(import.meta.dir, '../fixtures/weeder-check.sarif');
const FRICTION_WORK = join(import.meta.dir, '../fixtures/friction-work.sh');

// CI has no weeder; the real-binary case is skipped honestly rather than faked.
const WEEDER = Bun.which('weeder');

const WORK = 'bash -lc "echo made > out.txt"';

function plan(nodes: Array<{ id: string; smoke: string; work?: string }>) {
  return {
    goal: 'a gate findings log outlives the tree',
    source: 'e2e-gate-artifact',
    nodes: nodes.map(({ id, smoke, work }) => ({
      id,
      work: { command: work ?? WORK },
      accept: { smoke },
      policy: { maxAttempts: 1 },
    })),
  };
}

async function pleach(repo: string, args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: repo,
    env: process.env,
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code: code ?? 1, stdout };
}

async function run(repo: string, p: unknown): Promise<{ code: number; closed: string[] }> {
  const planPath = join(repo, 'plan.json');
  await Bun.write(planPath, JSON.stringify(p));
  const r = await pleach(repo, ['run', planPath, '--repo-root', repo]);
  const summary = JSON.parse(r.stdout.trim()) as { closed: string[] };
  return { code: r.code, closed: summary.closed };
}

function receiptsDir(repo: string): string {
  return join(repo, '.git', 'pleach', 'receipts');
}

async function readReceipt(repo: string, node: string): Promise<Receipt> {
  return JSON.parse(await readFile(join(receiptsDir(repo), `${node}.json`), 'utf8')) as Receipt;
}

function smokeGate(receipt: Receipt) {
  const gate = receipt.facts.gates.find((g) => g.gate === 'smoke');
  if (gate === undefined) throw new Error('no smoke gate in the receipt');
  return gate;
}

async function gateArtifactEvents(repo: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(repo, '.git', 'pleach', 'journal.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((e) => e.event === 'gate-artifact');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('gate artifacts — e2e', () => {
  let repo = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanup = r.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  test('SARIF stdout is kept beside the receipt under the sealed hash; plain stdout keeps nothing', async () => {
    const r = await run(
      repo,
      plan([
        { id: 'findings', smoke: `bash ${SARIF_SMOKE}` },
        { id: 'plain', smoke: `bash ${PLAIN_SMOKE}` },
      ]),
    );
    expect(r.code).toBe(0);
    expect(r.closed.sort()).toEqual(['findings', 'plain']);

    // The findings node: the file answers the seal, byte for byte.
    const receipt = await readReceipt(repo, 'findings');
    const sealed = smokeGate(receipt).artifactSha;
    expect(sealed).toMatch(/^[0-9a-f]{64}$/);

    const artifact = join(receiptsDir(repo), 'findings.sarif');
    const bytes = await readFile(artifact);
    expect(sealed).toBe(sha256(bytes));

    // Only stdout was kept: the gate's stderr line is nowhere in the file, and
    // what remains is the log the smoke printed, verbatim and still parseable.
    expect(bytes.toString('utf8')).not.toContain('judging the staged diff');
    expect(bytes.toString('utf8')).toBe(await readFile(SARIF_FIXTURE, 'utf8'));
    expect((JSON.parse(bytes.toString('utf8')) as { version: string }).version).toBe('2.1.0');

    // The receipt names the file outside its envelope, and still verifies.
    expect(receipt.artifacts?.sarif).toBe(artifact);
    const verify = await pleach(repo, ['receipt', 'findings', '--repo-root', repo]);
    expect(verify.code).toBe(0);
    expect((JSON.parse(verify.stdout.trim()) as { outcome: string }).outcome).toBe('pass');

    // One journal line says what was kept and where (beside the envelope every
    // line carries, which is pinned in the envelope's own tests).
    expect((await gateArtifactEvents(repo)).map(ownFields)).toEqual([
      { event: 'gate-artifact', node: 'findings', gate: 'smoke', path: artifact, sha256: sealed },
    ]);

    // The plain node: nothing sealed, nothing kept, nothing named.
    const plainReceipt = await readReceipt(repo, 'plain');
    expect(smokeGate(plainReceipt).artifactSha).toBeUndefined();
    expect(plainReceipt.artifacts?.sarif).toBeUndefined();
    expect(await Bun.file(join(receiptsDir(repo), 'plain.sarif')).exists()).toBe(false);
    const plainVerify = await pleach(repo, ['receipt', 'plain', '--repo-root', repo]);
    expect(plainVerify.code).toBe(0);
  }, 120_000);

  // A node is re-dispatched when its acceptance changes (§D acceptance
  // evolution) — which is precisely when the gate that produced a findings log
  // is replaced by one that produces none. The receipts dir is keyed by node
  // id alone, so the second close overwrites the receipt and, left to itself,
  // leaves the first close's files under the same names: a findings log and a
  // friction journal that no receipt seals, read as this close's by whoever
  // counts suppressions. What sits beside a receipt is what THAT close kept.
  test('a re-closed node keeps only what its own close sealed', async () => {
    const first = await run(
      repo,
      plan([{ id: 'evolving', smoke: `bash ${SARIF_SMOKE}`, work: `bash ${FRICTION_WORK}` }]),
    );
    expect(first.code).toBe(0);
    expect(first.closed).toEqual(['evolving']);
    expect(await Bun.file(join(receiptsDir(repo), 'evolving.sarif')).exists()).toBe(true);
    expect(await Bun.file(join(receiptsDir(repo), 'evolving.friction.jsonl')).exists()).toBe(true);

    // Same node, a gate that prints ordinary test output and work that leaves
    // no journal behind.
    const second = await run(repo, plan([{ id: 'evolving', smoke: `bash ${PLAIN_SMOKE}` }]));
    expect(second.code).toBe(0);
    expect(second.closed).toEqual(['evolving']);

    const receipt = await readReceipt(repo, 'evolving');
    expect(smokeGate(receipt).artifactSha).toBeUndefined();
    expect(receipt.artifacts).toBeUndefined();
    expect(await Bun.file(join(receiptsDir(repo), 'evolving.sarif')).exists()).toBe(false);
    expect(await Bun.file(join(receiptsDir(repo), 'evolving.friction.jsonl')).exists()).toBe(false);

    const verify = await pleach(repo, ['receipt', 'evolving', '--repo-root', repo]);
    expect(verify.code).toBe(0);
  }, 120_000);

  test.skipIf(WEEDER === null)(
    'the real weeder: `weeder check --strict` keeps its own SARIF under the sealed hash',
    async () => {
      const r = await run(repo, plan([{ id: 'weeded', smoke: 'weeder check --strict' }]));
      expect(r.code).toBe(0);
      expect(r.closed).toEqual(['weeded']);

      const receipt = await readReceipt(repo, 'weeded');
      const sealed = smokeGate(receipt).artifactSha;
      expect(sealed).toMatch(/^[0-9a-f]{64}$/);

      const artifact = join(receiptsDir(repo), 'weeded.sarif');
      const bytes = await readFile(artifact);
      expect(sealed).toBe(sha256(bytes));
      expect((JSON.parse(bytes.toString('utf8')) as { version: string }).version).toBe('2.1.0');
      expect(receipt.artifacts?.sarif).toBe(artifact);

      const verify = await pleach(repo, ['receipt', 'weeded', '--repo-root', repo]);
      expect(verify.code).toBe(0);
    },
    120_000,
  );

  // A real findings log is not a three-line fixture: it runs past the pipe
  // buffer many times over and carries prose in whatever language the rule
  // wrote. Both are where "the same bytes, one hash" is easy to lose — a
  // multi-byte character split across two reads decodes to a replacement
  // character, and the file would still answer its own hash while no longer
  // being what the gate printed. So the source of truth here is the process's
  // own output, not the seal.
  test('a findings log past the pipe buffer is kept verbatim, multi-byte text and all', async () => {
    const source = bigSarif();
    const smoke = join(repo, 'big-smoke.sh');
    await Bun.write(join(repo, 'big.sarif'), source);
    await Bun.write(
      smoke,
      `#!/usr/bin/env bash\nset -euo pipefail\ncat "${join(repo, 'big.sarif')}"\n`,
    );

    const r = await run(repo, plan([{ id: 'big', smoke: `bash ${smoke}` }]));
    expect(r.code).toBe(0);
    expect(r.closed).toEqual(['big']);

    const bytes = await readFile(join(receiptsDir(repo), 'big.sarif'));
    expect(bytes.toString('utf8')).toBe(source);
    expect(smokeGate(await readReceipt(repo, 'big')).artifactSha).toBe(sha256(bytes));
  }, 120_000);
});

// ~1 MB of SARIF whose messages are not ASCII — enough runs to cross the pipe
// buffer repeatedly, with multi-byte characters landing on no boundary in
// particular.
function bigSarif(): string {
  const results = Array.from({ length: 8000 }, (_, i) => ({
    ruleId: 'S2',
    message: { text: `naïve findung ${i} · 例 · 🌿` },
  }));
  return `${JSON.stringify({ version: '2.1.0', runs: [{ results }] }, null, 2)}\n`;
}
