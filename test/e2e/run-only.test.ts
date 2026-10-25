/**
 * E2E: `pleach run --only` through the real CLI + real git (issue #85).
 *
 * Command-only plans — no runner is ever spawned, so this runs everywhere
 * (CI included), like land.test.ts and examples.test.ts. Proves that a named
 * subset builds only its own chain, that a later full run resumes over the
 * already-verified slice, that an unknown id refuses with exit 2 naming it,
 * and that `--only` composes with `--land` (the named ids become the landing's
 * sinks).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
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

// A git read that answers '' when the ref or path is absent, rather than
// throwing — the assertions here need "does not exist" as an answer.
async function gitOrEmpty(repo: string, ...args: string[]): Promise<string> {
  const r = await execLocal(['git', '-C', repo, ...args], repo);
  return r.exitCode === 0 ? r.output.trim() : '';
}

const PLAN = {
  goal: 'a chain plus an unrelated node',
  source: 'e2e-run-only',
  nodes: [
    { id: 'a', work: { command: 'bash -lc "echo a > a.txt"' } },
    { id: 'b', needs: ['a'], work: { command: 'bash -lc "echo b > b.txt"' } },
    { id: 'c', work: { command: 'bash -lc "echo c > c.txt"' } },
  ],
};

describe('pleach run --only — e2e over command plans', () => {
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

  test('--only b builds b and its dependency, leaves c unbuilt, and a full run resumes over them', async () => {
    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(PLAN));

    const only = await pleach(
      ['run', '--no-redact', planPath, '--repo-root', repo, '--only', 'b'],
      repo,
    );
    expect(only.code).toBe(0);
    const first = JSON.parse(only.stdout.trim()) as {
      closed: string[];
      skipped: string[];
      alreadyVerified: string[];
    };
    expect(first.closed.sort()).toEqual(['a', 'b']);
    expect(first.skipped).toEqual([]);

    // The subset's branches exist; the out-of-scope node's does not.
    expect((await gitIn(repo, 'rev-parse', '--verify', 'node/a')).length).toBe(40);
    expect((await gitIn(repo, 'rev-parse', '--verify', 'node/b')).length).toBe(40);
    expect(await gitOrEmpty(repo, 'rev-parse', '--verify', 'node/c')).toBe(''); // never built

    // `pleach status` reads the scope from run-start: the left-out node is
    // out-of-scope, never skipped.
    const status = await pleach(['status', planPath, '--repo-root', repo], repo);
    expect(status.code).toBe(0);
    const state = JSON.parse(status.stdout.trim()) as {
      nodes: Record<string, { status: string }>;
    };
    expect(state.nodes.a?.status).toBe('closed');
    expect(state.nodes.b?.status).toBe('closed');
    expect(state.nodes.c?.status).toBe('out-of-scope');

    // A second full run skips the verified slice and builds only what remains.
    const full = await pleach(['run', '--no-redact', planPath, '--repo-root', repo], repo);
    expect(full.code).toBe(0);
    const second = JSON.parse(full.stdout.trim()) as {
      closed: string[];
      skipped: string[];
      alreadyVerified: string[];
    };
    expect(second.alreadyVerified.sort()).toEqual(['a', 'b']);
    expect(second.closed).toEqual(['c']);
    expect(second.skipped).toEqual([]);
  });

  test('--only with an unknown id refuses with exit 2, naming it', async () => {
    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(PLAN));

    const r = await pleach(
      ['run', '--no-redact', planPath, '--repo-root', repo, '--only', 'nosuch'],
      repo,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('nosuch');
  });

  test('--only with --land lands exactly the named node', async () => {
    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(PLAN));

    const r = await pleach(
      ['run', '--no-redact', planPath, '--repo-root', repo, '--only', 'b', '--land'],
      repo,
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim()) as {
      closed: string[];
      land?: { branch: string; sha: string; landed: string[] };
    };
    expect(out.closed.sort()).toEqual(['a', 'b']);
    expect(out.land?.landed).toEqual(['b']);

    // Only b landed: its tree (a.txt + b.txt) is on the branch; c.txt is not.
    expect(await gitIn(repo, 'show', 'HEAD:a.txt')).toBe('a');
    expect(await gitIn(repo, 'show', 'HEAD:b.txt')).toBe('b');
    expect(await gitOrEmpty(repo, 'show', 'HEAD:c.txt')).toBe('');
  });
});
