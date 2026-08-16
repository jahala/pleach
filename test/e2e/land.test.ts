/**
 * E2E: the landing step through the real CLI + real git (ledger B3).
 *
 * Command-only plans — no runner is ever spawned, so this runs everywhere
 * (CI included), like examples.test.ts. Verifies the two entry points
 * (`pleach land <plan>` and `pleach run --land`) and the refusal path.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
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

const GOOD_PLAN = {
  goal: 'two command nodes to land',
  source: 'e2e-land',
  nodes: [
    { id: 'lib', work: { command: 'bash -lc "echo lib > lib.txt"' } },
    { id: 'app', needs: ['lib'], work: { command: 'bash -lc "echo app > app.txt"' } },
  ],
};

const BROKEN_PLAN = {
  goal: 'a failing node blocks landing',
  source: 'e2e-land-broken',
  nodes: [
    { id: 'ok', work: { command: 'bash -lc "echo ok > ok.txt"' } },
    { id: 'broken', work: { command: 'bash -lc "exit 1"' } },
  ],
};

describe('pleach land — e2e over command plans', () => {
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

  test('run then land: the sink lands on the checked-out branch', async () => {
    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(GOOD_PLAN));

    const run = await pleach(['run', planPath, '--repo-root', repo], repo);
    expect(run.code).toBe(0);

    const land = await pleach(['land', planPath, '--repo-root', repo], repo);
    expect(land.code).toBe(0);
    const out = JSON.parse(land.stdout.trim()) as { branch: string; sha: string; landed: string[] };
    expect(out.landed).toEqual(['app']);
    expect(out.sha).toBe(await gitIn(repo, 'rev-parse', 'HEAD'));

    // The sink's tree (which contains lib's work) is on the branch now.
    expect(await gitIn(repo, 'show', 'HEAD:lib.txt')).toBe('lib');
    expect(await gitIn(repo, 'show', 'HEAD:app.txt')).toBe('app');
  });

  test('run --land: one invocation builds, verifies, and lands', async () => {
    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(GOOD_PLAN));

    const r = await pleach(['run', planPath, '--repo-root', repo, '--land'], repo);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim()) as {
      closed: string[];
      land?: { branch: string; sha: string; landed: string[] };
    };
    expect(out.closed.sort()).toEqual(['app', 'lib']);
    expect(out.land?.landed).toEqual(['app']);
    expect(await gitIn(repo, 'show', 'HEAD:app.txt')).toBe('app');
  });

  test('land refuses while any node is unverified; run --land does not land a red run', async () => {
    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(BROKEN_PLAN));

    const run = await pleach(['run', planPath, '--repo-root', repo, '--land'], repo);
    expect(run.code).toBe(1);
    const out = JSON.parse(run.stdout.trim()) as { land?: unknown };
    expect(out.land).toBeUndefined();

    const land = await pleach(['land', planPath, '--repo-root', repo], repo);
    expect(land.code).toBe(1);
    expect(land.stderr).toContain('broken');

    // Nothing landed: the branch still has only the initial commit's file.
    const files = await gitIn(repo, 'ls-tree', '--name-only', 'HEAD');
    expect(files.split('\n')).toEqual(['init.txt']);
  });
});
