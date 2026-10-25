/**
 * E2E: a land conflict is pinned and rebuilt, never merged by hand (issue #116).
 *
 * Two sibling sinks edit the same file. The first run verifies both; the first
 * land refuses on the second and pins it at the stack commit. The next run
 * rebuilds the pinned node on that stack — its own branch merged on top, the
 * conflict markers handed to a worker that keeps both changes — and the gates
 * judge the resolution. The next land lands both, with the file holding both
 * changes and no conflict marker anywhere. Real CLI + real git + the scripted
 * resolving runner (test/fixtures/land-rebuild-scripted.config.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRepo, gitIn } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const CONFIG = join(import.meta.dir, '../fixtures/land-rebuild-scripted.config.ts');

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

const PLAN = {
  goal: 'two siblings edit the same file; one rebuilds on the other',
  source: 'e2e-land-rebuild',
  nodes: [
    { id: 'a', work: { prompt: 'write A into shared.txt' } },
    { id: 'b', work: { prompt: 'write B into shared.txt' } },
  ],
};

describe('pleach land + rebuild — e2e (issue #116)', () => {
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

  async function journalLines(): Promise<Record<string, unknown>[]> {
    const raw = await readFile(join(repo, '.git', 'pleach', 'journal.jsonl'), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  test('a conflict is pinned, the node rebuilt on the stack, and both changes land', async () => {
    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(PLAN));
    const before = await gitIn(repo, 'rev-parse', 'HEAD');

    // 1. Run: both siblings verify.
    const run1 = await pleach(
      [
        'run',
        '--no-redact',
        planPath,
        '--config',
        CONFIG,
        '--repo-root',
        repo,
        '--max-concurrency',
        '2',
      ],
      repo,
    );
    expect(run1.code).toBe(0);
    expect(JSON.parse(run1.stdout.trim()).closed.sort()).toEqual(['a', 'b']);

    // 2. Land: b conflicts with a, refuses, and pins b at the stack commit.
    const land1 = await pleach(
      ['land', '--no-redact', planPath, '--config', CONFIG, '--repo-root', repo],
      repo,
    );
    expect(land1.code).toBe(1);
    expect(land1.stderr).toContain('conflict');
    const conflict = (await journalLines()).find((e) => e.event === 'land-conflict');
    expect(conflict).toMatchObject({
      node: 'b',
      files: ['shared.txt'],
      rebuildRef: 'refs/pleach/rebuild/b',
    });
    const stackSha = conflict?.stackSha as string;
    expect(await gitIn(repo, 'rev-parse', 'refs/pleach/rebuild/b')).toBe(stackSha);
    // The stack is the target plus A's work, and the target branch is untouched.
    expect(await gitIn(repo, 'show', `${stackSha}:shared.txt`)).toBe('A');
    expect(await gitIn(repo, 'rev-parse', 'HEAD')).toBe(before);

    // 3. Run again: b is rebuilt on the stack.
    const run2 = await pleach(
      ['run', '--no-redact', planPath, '--config', CONFIG, '--repo-root', repo],
      repo,
    );
    expect(run2.code).toBe(0);
    expect(JSON.parse(run2.stdout.trim()).closed).toEqual(['b']);

    const lines = await journalLines();
    expect(
      lines.some((e) => e.event === 'land-rebuild' && e.node === 'b' && e.onto === stackSha),
    ).toBe(true);
    expect(lines.some((e) => e.event === 'land-rebuild-done' && e.node === 'b')).toBe(true);
    // The rebuild published a node/b that descends from the stack commit, and
    // the pin was cleared.
    const nodeB = await gitIn(repo, 'rev-parse', 'node/b');
    expect(await gitIn(repo, 'merge-base', stackSha, nodeB)).toBe(stackSha);

    // 4. Land again: both sinks land, and the file holds both changes.
    const land2 = await pleach(
      ['land', '--no-redact', planPath, '--config', CONFIG, '--repo-root', repo],
      repo,
    );
    expect(land2.code).toBe(0);
    expect(JSON.parse(land2.stdout.trim()).landed.sort()).toEqual(['a', 'b']);
    const shared = await gitIn(repo, 'show', 'HEAD:shared.txt');
    expect(shared).toBe('A\nB');
    expect(shared).not.toContain('<<<<<<<');
  });
});
