/**
 * E2E: pleach says when verified work exists only on this machine (issue #130).
 *
 * Real CLI + real git. Command-only plans — no runner is ever spawned, so this
 * runs everywhere. A second temp bare repo plays the remote, so "on no remote"
 * is a real git fact, not a mock: `git for-each-ref` and `git rev-list` over
 * local data only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepo, execLocal, gitIn } from '../support/git-repo.ts';

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

async function journalEvents(repo: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(repo, '.git', 'pleach', 'journal.jsonl'), 'utf8');
  return text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function lastRunEnd(events: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return events.filter((e) => e.event === 'run-end').at(-1);
}

function twoNodePlan(source: string): Record<string, unknown> {
  return {
    goal: 'two command nodes',
    source,
    nodes: [
      { id: 'a', work: { command: 'bash -lc "echo a > a.txt"' } },
      { id: 'b', work: { command: 'bash -lc "echo b > b.txt"' } },
    ],
  };
}

function oneNodePlan(source: string): Record<string, unknown> {
  return {
    goal: 'one command node',
    source,
    nodes: [{ id: 'a', work: { command: 'bash -lc "echo a > a.txt"' } }],
  };
}

describe('pleach local-only — e2e over command plans (issue #130)', () => {
  let repo = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();
  let scratch = '';

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanup = r.cleanup;
    scratch = await mkdtemp(join(tmpdir(), 'pleach-local-only-'));
  });

  afterEach(async () => {
    await cleanup();
    await rm(scratch, { recursive: true, force: true });
  });

  test('a run-end names the unpushed node branches; pushing one clears only it', async () => {
    // A bare remote plays origin; the local repo tracks it but has pushed nothing.
    const remote = join(scratch, 'remote.git');
    await execLocal(['git', 'clone', '--bare', '-q', repo, remote], repo);
    await gitIn(repo, 'remote', 'add', 'origin', remote);
    await gitIn(repo, 'fetch', 'origin');

    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(twoNodePlan('e2e-local-only')));

    const run1 = await pleach(['run', '--no-redact', planPath, '--repo-root', repo], repo);
    expect(run1.code).toBe(0);

    const events1 = await journalEvents(repo);
    const end1 = lastRunEnd(events1);
    expect(end1?.localOnly).toEqual({ nodeBranches: ['node/a', 'node/b'], remotes: 1 });
    expect(run1.stderr).toContain('2 verified node branch(es) exist only on this machine');

    // The conductor pushes one node branch; the next run names only the other.
    await gitIn(repo, 'push', '-q', 'origin', 'node/a');

    const run2 = await pleach(['run', '--no-redact', planPath, '--repo-root', repo], repo);
    expect(run2.code).toBe(0);

    const events2 = await journalEvents(repo);
    const end2 = lastRunEnd(events2);
    expect(end2?.localOnly).toEqual({ nodeBranches: ['node/b'], remotes: 1 });
    expect(run2.stderr).toContain('1 verified node branch(es) exist only on this machine');
  });

  test('a repository with no remote says so', async () => {
    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(twoNodePlan('e2e-local-only-noremote')));

    const run = await pleach(['run', '--no-redact', planPath, '--repo-root', repo], repo);
    expect(run.code).toBe(0);

    const events = await journalEvents(repo);
    const end = lastRunEnd(events);
    expect(end?.localOnly).toEqual({ nodeBranches: ['node/a', 'node/b'], remotes: 0 });
    expect(run.stderr).toContain('no remote');
  });

  test('landing onto a branch whose upstream is behind reports aheadOfUpstream', async () => {
    const remote = join(scratch, 'remote.git');
    await execLocal(['git', 'clone', '--bare', '-q', repo, remote], repo);
    await gitIn(repo, 'remote', 'add', 'origin', remote);
    await gitIn(repo, 'fetch', 'origin');
    const branch = await gitIn(repo, 'symbolic-ref', '--short', 'HEAD');
    await gitIn(repo, 'branch', '--set-upstream-to', `origin/${branch}`, branch);

    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(oneNodePlan('e2e-local-only-land')));
    const run = await pleach(['run', '--no-redact', planPath, '--repo-root', repo], repo);
    expect(run.code).toBe(0);

    const land = await pleach(['land', '--no-redact', planPath, '--repo-root', repo], repo);
    expect(land.code).toBe(0);

    const events = await journalEvents(repo);
    const landed = events.find((e) => e.event === 'landed');
    expect(landed?.localOnly).toEqual({ aheadOfUpstream: 1 });
    expect(land.stderr).toContain('1 commit(s) ahead of its upstream');
  });
});
