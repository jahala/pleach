/**
 * E2E: `pleach status` and `pleach wait` against the real CLI, real git, and a
 * real background run (ledger #114). No runner, no mocks: every plan is
 * {command} work.
 *
 *   (a) A three-node run started in the background: `wait` returns once, all
 *       three closed, exit 0.
 *   (b) A node sleeping 30s: `wait --node <id> --timeout 1` exits 124 and
 *       names the node; the run is killed in `finally`.
 *   (c) `status` on a finished run prints the same node statuses the run's
 *       `run-end` line reports.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRepo } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface StateJson {
  started: boolean;
  ended: boolean;
  run: string;
  runId?: string;
  nodes: Record<string, { status: string; attempts?: number; durationMs?: number }>;
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

function spawnRun(repo: string, planPath: string) {
  return Bun.spawn(['bun', MAIN, 'run', planPath, '--repo-root', repo], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
    cwd: repo,
  });
}

const journalPath = (repo: string): string => join(repo, '.git', 'pleach', 'journal.jsonl');

async function waitForRunStart(repo: string, source: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const raw = await readFile(journalPath(repo), 'utf8');
      const lines = raw
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      if (lines.some((l) => l.event === 'run-start' && l.source === source)) return;
    } catch {
      // the journal is not written yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for run-start of '${source}'`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const SOURCE = 'e2e-status-wait';

describe('pleach status / wait — e2e', () => {
  let repo = '';
  let planPath = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanup = r.cleanup;
    planPath = join(repo, 'plan.json');
    await writeFile(
      planPath,
      JSON.stringify({
        goal: 'three command nodes that all close',
        source: SOURCE,
        nodes: [
          { id: 'a', work: { command: 'bash -lc "echo a > a.txt"' } },
          { id: 'b', work: { command: 'bash -lc "echo b > b.txt"' } },
          { id: 'c', work: { command: 'bash -lc "echo c > c.txt"' } },
        ],
      }),
    );
  });

  afterEach(async () => {
    await cleanup();
  });

  test('wait on a background run returns once with all three nodes closed and exit 0', async () => {
    const run = spawnRun(repo, planPath);
    try {
      await waitForRunStart(repo, SOURCE);
      const w = await pleach(['wait', planPath, '--repo-root', repo], repo);
      expect(w.code).toBe(0);
      const state = JSON.parse(w.stdout.trim()) as StateJson;
      expect(state.run).toBe('ended');
      expect(state.ended).toBe(true);
      for (const id of ['a', 'b', 'c']) expect(state.nodes[id]?.status).toBe('closed');
    } finally {
      await run.exited;
    }
  }, 60_000);

  test('wait --node --timeout 1 exits 124 and names the still-running node', async () => {
    const slowPlan = join(repo, 'slow.json');
    await writeFile(
      slowPlan,
      JSON.stringify({
        goal: 'a node that sleeps',
        source: 'e2e-status-wait-slow',
        nodes: [{ id: 'slow', work: { command: 'bash -lc "sleep 30"' } }],
      }),
    );
    const run = spawnRun(repo, slowPlan);
    try {
      await waitForRunStart(repo, 'e2e-status-wait-slow');
      const w = await pleach(
        ['wait', slowPlan, '--repo-root', repo, '--node', 'slow', '--timeout', '1'],
        repo,
      );
      expect(w.code).toBe(124);
      expect(w.stderr).toContain('slow');
    } finally {
      run.kill();
      await run.exited;
    }
  }, 60_000);

  test('status on a finished run prints the same node statuses as its run-end', async () => {
    const r = await pleach(['run', planPath, '--repo-root', repo], repo);
    expect(r.code).toBe(0);
    const summary = JSON.parse(r.stdout.trim()) as { closed: string[] };
    expect(summary.closed.sort()).toEqual(['a', 'b', 'c']);

    const s = await pleach(['status', planPath, '--repo-root', repo], repo);
    expect(s.code).toBe(0);
    const state = JSON.parse(s.stdout.trim()) as StateJson;
    expect(state.ended).toBe(true);
    expect(state.run).toBe('ended');
    for (const id of ['a', 'b', 'c']) {
      expect(state.nodes[id]?.status).toBe('closed');
      expect(s.stderr).toContain(id);
    }
  }, 60_000);

  test('status with no run of this source exits 3', async () => {
    const s = await pleach(['status', planPath, '--repo-root', repo], repo);
    expect(s.code).toBe(3);
    expect(s.stderr).toContain(SOURCE);
  }, 60_000);
});
