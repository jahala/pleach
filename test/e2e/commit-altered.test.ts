/**
 * E2E: the verified commit holds the tree its gates judged (ledger D24),
 * through the real CLI + real git. No runner and no mocks: {command} work.
 *
 * The repository's own pre-commit hook stages a file of its own while the
 * verified commit runs. The gates never judged that file, so the node settles
 * failed under the commit gate, the hook's change named in the verdict: its
 * tree kept on quarantine/<id>, its receipt written, nothing published.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRepo, execLocal, gitIn } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

interface Summary {
  closed: string[];
  failed: string[];
  quarantined: string[];
}

interface Receipt {
  facts: { status: string; gates: { gate: string }[] };
  refs?: { quarantineBranch?: string };
}

type Line = Record<string, unknown>;

async function pleachRun(
  repo: string,
  planPath: string,
): Promise<{ code: number; summary: Summary }> {
  const proc = Bun.spawn(['bun', MAIN, 'run', planPath, '--repo-root', repo], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: repo,
    env: process.env,
  });
  const [stdout, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, summary: JSON.parse(stdout.trim()) as Summary };
}

const pleachDir = (repo: string): string => join(repo, '.git', 'pleach');

async function journalLines(repo: string): Promise<Line[]> {
  return (await readFile(join(pleachDir(repo), 'journal.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Line);
}

describe('the verified commit holds the judged tree — e2e (D24)', () => {
  let repo = '';
  let planPath = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanup = r.cleanup;
    planPath = join(repo, 'plan.json');
  });

  afterEach(async () => {
    await cleanup();
  });

  // ledger: D24 — a hook that changes the commit is refused like a hook that refuses it.
  test('a pre-commit hook that stages its own file: failed node, quarantine, receipt, nothing published', async () => {
    const hooks = join(repo, '.githooks');
    await mkdir(hooks);
    await writeFile(
      join(hooks, 'pre-commit'),
      '#!/bin/sh\necho "added at commit time" > stamped.txt\ngit add stamped.txt\n',
    );
    await chmod(join(hooks, 'pre-commit'), 0o755);
    await gitIn(repo, 'add', '.githooks/pre-commit');
    await gitIn(repo, 'commit', '-m', 'the house hook');
    await gitIn(repo, 'config', 'core.hooksPath', '.githooks');
    const base = await gitIn(repo, 'rev-parse', 'HEAD');

    await writeFile(
      planPath,
      JSON.stringify({
        goal: 'a commit that changed after its gates must not publish',
        source: 'e2e-commit-altered',
        nodes: [
          {
            id: 'built',
            work: { command: 'bash -lc "echo finished > built.txt"' },
            policy: { maxAttempts: 1 },
          },
        ],
      }),
    );

    const { code, summary } = await pleachRun(repo, planPath);
    expect(code).toBe(1);
    expect(summary.failed).toEqual(['built']);
    expect(summary.closed).toEqual([]);
    expect(summary.quarantined).toEqual(['built']);

    const lines = (await journalLines(repo)).filter((l) => l.node === 'built');
    expect(lines.find((l) => l.event === 'gate-fail')).toMatchObject({ gate: 'commit' });
    const verdict = lines.find((l) => l.event === 'verdict') as {
      status: string;
      gate: { ran: string; outputTail: string };
    };
    expect(verdict.status).toBe('failed');
    expect(verdict.gate.ran).toBe('commit');
    expect(verdict.gate.outputTail).toContain('stamped.txt');

    // The tree is kept, the judged work in it, standing on the node's base:
    // the commit the hook changed is in no history.
    expect(await gitIn(repo, 'show', 'quarantine/built:built.txt')).toBe('finished');
    expect(await gitIn(repo, 'rev-parse', 'quarantine/built^')).toBe(base);

    const receipt = JSON.parse(
      await readFile(join(pleachDir(repo), 'receipts', 'built.json'), 'utf8'),
    ) as Receipt;
    expect(receipt.facts.status).toBe('failed');
    expect(receipt.facts.gates.at(-1)?.gate).toBe('commit');
    expect(receipt.refs?.quarantineBranch).toBe('quarantine/built');

    const branches = await execLocal(['git', '-C', repo, 'for-each-ref', 'refs/heads/node/'], repo);
    expect(branches.output.trim()).toBe('');
  }, 60_000);
});
