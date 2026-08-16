/**
 * E2E: quarantine through the real CLI + real git. A command node writes a
 * file and then fails its gate — the partial work must survive on
 * quarantine/<id> for inspection, while node/<id> is never published.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRepo, execLocal, gitIn } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

const PLAN = {
  goal: 'partial work must be preserved',
  source: 'e2e-quarantine',
  nodes: [
    {
      id: 'doomed',
      work: { command: 'bash -lc "echo half-done > partial.txt; exit 1"' },
      policy: { maxAttempts: 1 },
    },
  ],
};

describe('quarantine — e2e', () => {
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

  test('failed command node: quarantine branch holds the partial file, node/* absent', async () => {
    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(PLAN));

    const proc = Bun.spawn(['bun', MAIN, 'run', planPath, '--repo-root', repo], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: repo,
      env: process.env,
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    const summary = JSON.parse(stdout.trim()) as { failed: string[]; quarantined: string[] };
    expect(code).toBe(1);
    expect(summary.failed).toEqual(['doomed']);
    expect(summary.quarantined).toEqual(['doomed']);

    // The evidence survives, un-published.
    expect(await gitIn(repo, 'show', 'quarantine/doomed:partial.txt')).toBe('half-done');
    const nodeRefs = await execLocal(['git', '-C', repo, 'for-each-ref', 'refs/heads/node/'], repo);
    expect(nodeRefs.output.trim()).toBe('');
    // No worktree leaked.
    expect((await gitIn(repo, 'worktree', 'list')).split('\n').length).toBe(1);
  }, 60_000);
});
