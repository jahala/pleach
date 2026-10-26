/**
 * E2E: plan reload through the real CLI + real git (issue #70).
 *
 * A two-node plan (A is {prompt}, B is {command}) runs through the bundled
 * scriptedRunner. A's worker rewrites plan.json on disk while A runs, changing
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
const SRC = join(import.meta.dir, '../../src');

const SOURCE = 'e2e-plan-reload';

interface PlanNode {
  id: string;
  work: { prompt: string } | { command: string };
  needs?: string[];
  accept?: { smoke?: string };
  policy?: { maxAttempts: number };
}

const nodeA: PlanNode = {
  id: 'a',
  work: { prompt: 'build a' },
  policy: { maxAttempts: 1 },
};

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

const plan = (b: PlanNode): object => ({
  goal: 'a node corrects the plan while its dependency runs',
  source: SOURCE,
  nodes: [nodeA, b],
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
    await writeFile(planPath, JSON.stringify(plan(nodeBOld), null, 2));

    // The scripted runner's A scenario writes A's own tree AND the plan.json at
    // the repo root. The worktree is <repo>/.git/pleach/worktrees/wt-*/wt, so
    // the repo root is five levels up.
    const configBody = `import { gitLedger } from '${SRC}/adapters/git.ts';
import { scriptedRunner } from '${SRC}/adapters/scripted.ts';

export default {
  runner: scriptedRunner([
    {
      prompt: 'build a',
      files: {
        'a.txt': 'made',
        '../../../../../plan.json': ${JSON.stringify(JSON.stringify(plan(nodeBNew)))},
      },
    },
  ]),
  ledger: gitLedger(),
};
`;
    await writeFile(join(repo, 'pleach.config.ts'), configBody);

    const proc = Bun.spawn(
      ['bun', MAIN, 'run', '--no-redact', planPath, '--config', join(repo, 'pleach.config.ts')],
      { cwd: repo, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env },
    );
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
