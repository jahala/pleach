/**
 * E2E: the receipt verb (§D) through the real CLI + real git. A command node
 * closes; its receipt file exists under <git-dir>/pleach/receipts/, the
 * node commit carries the receipt-sha256 trailer, and `pleach receipt`
 * answers PASS (0) on the honest record, TAMPERED (1) after a hand-edit,
 * UNDERIVABLE (2) for a node with no receipt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRepo, gitIn } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

const PLAN = {
  goal: 'receipts pin the close',
  source: 'e2e-receipt',
  nodes: [
    {
      id: 'writer',
      work: { command: 'bash -lc "echo made > out.txt"' },
      accept: { smoke: 'test -f out.txt' },
      policy: { maxAttempts: 1 },
    },
  ],
};

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

describe('receipt verb — e2e', () => {
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

  test('close → PASS; hand-tamper → TAMPERED; ghost node → UNDERIVABLE', async () => {
    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(PLAN));

    const run = await pleach(repo, ['run', planPath, '--repo-root', repo]);
    expect(run.code).toBe(0);

    // The trailer is pinned in the published commit.
    const message = await gitIn(repo, 'show', '-s', '--format=%B', 'node/writer');
    expect(message).toContain('receipt-sha256: ');

    // PASS on the honest record.
    const pass = await pleach(repo, ['receipt', 'writer', '--repo-root', repo]);
    expect(pass.code).toBe(0);
    const passJson = JSON.parse(pass.stdout.trim()) as Record<string, unknown>;
    expect(passJson.outcome).toBe('pass');
    expect(passJson.derived).toBe('publishable');
    expect(message).toContain(`receipt-sha256: ${passJson.sha256}`);

    // Hand-tamper a fact in the receipt file.
    const receiptPath = join(repo, '.git', 'pleach', 'receipts', 'writer.json');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
      facts: { attempts: number };
    };
    receipt.facts.attempts = 99;
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2));

    const tampered = await pleach(repo, ['receipt', 'writer', '--repo-root', repo]);
    expect(tampered.code).toBe(1);
    expect((JSON.parse(tampered.stdout.trim()) as Record<string, unknown>).outcome).toBe(
      'tampered',
    );

    // A node that never settled has nothing to derive.
    const ghost = await pleach(repo, ['receipt', 'ghost', '--repo-root', repo]);
    expect(ghost.code).toBe(2);
    expect((JSON.parse(ghost.stdout.trim()) as Record<string, unknown>).outcome).toBe(
      'underivable',
    );
  }, 60_000);
});
