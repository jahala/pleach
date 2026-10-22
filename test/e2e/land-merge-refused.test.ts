/**
 * E2E: a landing whose merge the repository's own hook refuses (ledger D21),
 * through the real CLI + real git. Command-only plans — no runner spawns.
 *
 * `pleach run` verifies a node whose branch is based on the run's base; the
 * operator then moves the checked-out branch one commit past that base and
 * installs a refusing `commit-msg` hook. `pleach land` must exit non-zero with
 * the hook's own words on stderr — a refusal, not a "conflicts in: <nothing>".
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRepo, gitIn } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function pleach(args: string[], cwd: string): Promise<RunResult> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
    cwd,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, stdout, stderr };
}

describe('pleach land — a hook-refused merge, through the real CLI', () => {
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

  // ledger: D28 — through the real CLI, the hook's words reach the operator.
  test('land exits non-zero and stderr carries the hook words', async () => {
    const planPath = join(repo, 'plan.json');
    await writeFile(
      planPath,
      JSON.stringify({
        goal: 'a landing a hook will refuse',
        source: 'e2e-land-merge-refused',
        nodes: [{ id: 'one', work: { command: 'bash -lc "echo other > other.txt"' } }],
      }),
    );

    const run = await pleach(['run', '--no-redact', planPath, '--repo-root', repo], repo);
    expect(run.code).toBe(0);

    // Move the checked-out branch one commit past the node branch's base.
    await writeFile(join(repo, 'move.txt'), 'moved\n');
    await gitIn(repo, 'add', 'move.txt');
    await gitIn(repo, 'commit', '-m', 'branch moved past base');

    // A committed commit-msg hook that refuses every merge message.
    const hooks = join(repo, '.githooks');
    await mkdir(hooks);
    await writeFile(
      join(hooks, 'commit-msg'),
      '#!/bin/sh\necho "house rule: no merges from this tree" >&2\nexit 1\n',
    );
    await chmod(join(hooks, 'commit-msg'), 0o755);
    await gitIn(repo, 'add', '.githooks/commit-msg');
    await gitIn(repo, 'commit', '-m', 'the house hook');
    await gitIn(repo, 'config', 'core.hooksPath', '.githooks');

    const before = await gitIn(repo, 'rev-parse', 'HEAD');

    const land = await pleach(['land', '--no-redact', planPath, '--repo-root', repo], repo);

    expect(land.code).toBe(1);
    expect(land.stderr).toContain('house rule: no merges from this tree');
    expect(land.stderr).toContain('node/one');
    expect(land.stderr).not.toContain('conflicts in');

    // Untouched: tip unmoved, no worktree left behind.
    expect(await gitIn(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect((await gitIn(repo, 'worktree', 'list')).split('\n').length).toBe(1);
  }, 120000);
});
