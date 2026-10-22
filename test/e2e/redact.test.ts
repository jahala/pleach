// ledger: D37
// issue #107 — redaction at the face, as a real process. Two edges the loop
// suite cannot reach: a run refused (exit 2) before any journal line when the
// redactor binary is missing, and `--no-redact` letting a run proceed with its
// opt-out recorded on run-start.
import { describe, expect, test } from 'bun:test';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRepo } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

async function pleach(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, stdout, stderr };
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// One effect-free command node — no runner, no tend, no plotplot needed to run.
async function writePlan(repo: string): Promise<string> {
  const plan = { goal: 'g', source: repo, nodes: [{ id: 'x', work: { command: 'true' } }] };
  const planPath = join(repo, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  return planPath;
}

const journalAt = (repo: string): string => join(repo, '.git', 'pleach', 'journal.jsonl');

describe('pleach redaction — e2e', () => {
  test('a missing plotplot binary refuses the run (exit 2) before any journal line', async () => {
    const { path: repo, cleanup } = await createRepo();
    try {
      const planPath = await writePlan(repo);
      const r = await pleach([
        'run',
        planPath,
        '--repo-root',
        repo,
        '--plotplot-bin',
        '/nonexistent',
      ]);

      expect(r.code).toBe(2);
      expect(r.stderr).toContain('cargo install --locked --git https://github.com/jahala/plotplot');
      // Refused before the lock was taken and before run-start was written.
      expect(await exists(journalAt(repo))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test('--no-redact runs, and run-start records redaction: off', async () => {
    const { path: repo, cleanup } = await createRepo();
    try {
      const planPath = await writePlan(repo);
      const r = await pleach(['run', planPath, '--repo-root', repo, '--no-redact']);

      expect(r.code).toBe(0);
      const journal = await readFile(journalAt(repo), 'utf8');
      const runStart = JSON.parse(journal.trim().split('\n')[0] ?? '') as Record<string, unknown>;
      expect(runStart.redaction).toBe('off');
    } finally {
      await cleanup();
    }
  });
});
