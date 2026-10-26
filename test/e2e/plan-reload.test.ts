/**
 * E2E: plan reload through the real CLI + real git (issue #70).
 *
 * A two-node plan of command nodes. A's command rewrites plan.json on disk
 * while A runs, changing
 * B's work.command and accept.smoke. Before B launches the scheduler re-reads
 * the plan; B runs the NEW command (its verified close proves it — the new
 * smoke only passes over the new command's output), and B's close receipt
 * records the NEW acceptance.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRepo } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

const SOURCE = 'e2e-plan-reload';

interface PlanNode {
  id: string;
  work: { prompt: string } | { command: string };
  needs?: string[];
  accept?: { smoke?: string };
  policy?: { maxAttempts: number };
}

// A's command writes the corrected plan over plan.json, by absolute path, the
// way a conductor edits the plan while a run is under way.
const nodeA = (planPath: string, nextPath: string): PlanNode => ({
  id: 'a',
  work: { command: `bash -lc "cp '${nextPath}' '${planPath}' && echo made > a.txt"` },
  policy: { maxAttempts: 1 },
});

const nodeBOld: PlanNode = {
  id: 'b',
  needs: ['a'],
  work: { command: 'bash -lc "echo old > result.txt"' },
  accept: { smoke: 'grep -q old result.txt' },
  policy: { maxAttempts: 1 },
};

const nodeBNew: PlanNode = {
  id: 'b',
  needs: ['a'],
  work: { command: 'bash -lc "echo new > result.txt"' },
  accept: { smoke: 'grep -q new result.txt' },
  policy: { maxAttempts: 1 },
};

const plan = (a: PlanNode, b: PlanNode): object => ({
  goal: 'a node corrects the plan while its dependency runs',
  source: SOURCE,
  nodes: [a, b],
});

describe('plan reload — e2e (issue #70)', () => {
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

  test('A rewrites plan.json; B runs the new command and records the new acceptance', async () => {
    const planPath = join(repo, 'plan.json');
    const nextPath = join(repo, 'next-plan.json');
    const a = nodeA(planPath, nextPath);
    await writeFile(planPath, JSON.stringify(plan(a, nodeBOld), null, 2));
    await writeFile(nextPath, JSON.stringify(plan(a, nodeBNew), null, 2));

    const proc = Bun.spawn(['bun', MAIN, 'run', '--no-redact', planPath, '--repo-root', repo], {
      cwd: repo,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(code).toBe(0);
    const summary = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
      closed?: string[];
    };
    expect(summary.closed?.sort()).toEqual(['a', 'b']);

    // B ran the new command: its verified close is only possible because the
    // new smoke ('grep -q new result.txt') passed over the new command's output.
    const receipt = JSON.parse(
      await readFile(join(repo, '.git', 'pleach', 'receipts', 'b.json'), 'utf8'),
    ) as { facts: { acceptance: { smoke?: string } } };
    expect(receipt.facts.acceptance.smoke).toBe('grep -q new result.txt');

    // The journal names the reload that made it happen.
    const journal = await readFile(join(repo, '.git', 'pleach', 'journal.jsonl'), 'utf8');
    expect(journal).toContain('plan-reloaded');
    expect(stderr).not.toContain('refused');
  }, 60_000);
});
