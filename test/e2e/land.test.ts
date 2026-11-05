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

// Two sinks whose smokes each pass alone (a has only a.txt, b has only b.txt)
// but fail on the composed stack (each sees the other's file). The refusal must
// name both culprits, each with its own smoke's output, so the operator reads
// why the gate said no instead of only that it did (issue #124).
const INCOMPATIBLE_PLAN = {
  goal: 'two sinks that cannot land together',
  source: 'e2e-land-incompatible',
  nodes: [
    {
      id: 'a',
      work: { command: 'bash -lc "echo a > a.txt"' },
      accept: { smoke: 'bash -lc \'if [ -f b.txt ]; then echo "RED: A"; exit 1; fi\'' },
    },
    {
      id: 'b',
      work: { command: 'bash -lc "echo b > b.txt"' },
      accept: { smoke: 'bash -lc \'if [ -f a.txt ]; then echo "RED: B"; exit 1; fi\'' },
    },
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

    const run = await pleach(['run', '--no-redact', planPath, '--repo-root', repo], repo);
    expect(run.code).toBe(0);

    const land = await pleach(['land', '--no-redact', planPath, '--repo-root', repo], repo);
    expect(land.code).toBe(0);
    const out = JSON.parse(land.stdout.trim()) as { branch: string; sha: string; landed: string[] };
    expect(out.landed).toEqual(['app']);
    expect(out.sha).toBe(await gitIn(repo, 'rev-parse', 'HEAD'));

    // The sink's tree (which contains lib's work) is on the branch now.
    expect(await gitIn(repo, 'show', 'HEAD:lib.txt')).toBe('lib');
    expect(await gitIn(repo, 'show', 'HEAD:app.txt')).toBe('app');
  }, 60_000);

  test('run --land: one invocation builds, verifies, and lands', async () => {
    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(GOOD_PLAN));

    const r = await pleach(['run', '--no-redact', planPath, '--repo-root', repo, '--land'], repo);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim()) as {
      closed: string[];
      land?: { branch: string; sha: string; landed: string[] };
    };
    expect(out.closed.sort()).toEqual(['app', 'lib']);
    expect(out.land?.landed).toEqual(['app']);
    expect(await gitIn(repo, 'show', 'HEAD:app.txt')).toBe('app');
  }, 60_000);

  test('land refuses while any node is unverified; run --land does not land a red run', async () => {
    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(BROKEN_PLAN));

    const run = await pleach(['run', '--no-redact', planPath, '--repo-root', repo, '--land'], repo);
    expect(run.code).toBe(1);
    const out = JSON.parse(run.stdout.trim()) as { land?: unknown };
    expect(out.land).toBeUndefined();

    const land = await pleach(['land', '--no-redact', planPath, '--repo-root', repo], repo);
    expect(land.code).toBe(1);
    expect(land.stderr).toContain('broken');

    // Nothing landed: the branch still has only the initial commit's file.
    const files = await gitIn(repo, 'ls-tree', '--name-only', 'HEAD');
    expect(files.split('\n')).toEqual(['init.txt']);
    // Each test here spawns two real `pleach` subprocesses (cold `bun` start
    // plus git); under five parallel suites that exceeds bun's 5 s default
    // (issue #160). The bound catches a hang, never the subprocesses' work.
  }, 60_000);

  // issue #124 — a land refusal that ran a command and went red must print
  // that command's output tail, not just its command. Two incompatible sinks
  // name two culprits, and each culprit line carries its own smoke's words.
  test('a land refusal prints each culprit sink with its smoke output tail', async () => {
    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(INCOMPATIBLE_PLAN));

    const run = await pleach(['run', '--no-redact', planPath, '--repo-root', repo], repo);
    expect(run.code).toBe(0);

    const land = await pleach(['land', '--no-redact', planPath, '--repo-root', repo], repo);
    expect(land.code).toBe(1);
    // Each culprit's own smoke output reaches stderr under its culprit line.
    expect(land.stderr).toContain('RED: A');
    expect(land.stderr).toContain('RED: B');
    expect(land.stderr).toContain('culprit');

    // Nothing landed: the branch still has only the initial commit's file.
    const files = await gitIn(repo, 'ls-tree', '--name-only', 'HEAD');
    expect(files.split('\n')).toEqual(['init.txt']);
  }, 120_000);
});
