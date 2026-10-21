/**
 * E2E: a failed gate never edits what the retry starts from (ledger #131)
 * through the real CLI, real git and a real smoke process.
 *
 * A `{command}` node's command writes `page.md` once (idempotent, so the worker
 * retry does not rewrite it). Its smoke appends a `[!]` mark to that page and
 * goes red on the first two runs (the attempt's gate-only retry included), then
 * passes. A marker file OUTSIDE the worktree counts the runs. The fix records
 * the tree before the gate and rewinds the red runs, so the published
 * `node/<id>` never carries the mark.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { execLocal } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

const SMOKE = `#!/usr/bin/env bash
set -euo pipefail
marker="$1"
n=0
if [ -f "$marker" ]; then n=$(cat "$marker"); fi
n=$((n + 1))
echo "$n" > "$marker"
if [ "$n" -le 2 ]; then
  printf '[!] flaked\\n' >> page.md
  exit 1
fi
exit 0
`;

// The command writes the page only once: the worker retry does not rewrite it,
// so a mark the failed smoke left would survive into the retry's staging set.
const COMMAND = 'bash -lc "[ -f page.md ] || echo done > page.md"';

function plan(smoke: string) {
  return {
    goal: 'a failed gate never edits what the retry starts from',
    source: 'e2e-gate-writes-restored',
    nodes: [{ id: 'x', work: { command: COMMAND }, accept: { smoke }, policy: { maxAttempts: 2 } }],
  };
}

async function pleach(repo: string, args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: repo,
    env: process.env,
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code: code ?? 1, stdout };
}

describe('gate writes restored — e2e', () => {
  let repo = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();

  beforeEach(async () => {
    const { createRepo } = await import('../support/git-repo.ts');
    const r = await createRepo();
    repo = r.path;
    cleanup = r.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  test('a smoke that stamps [!] and flakes is rewound; node/x carries no mark', async () => {
    const smoke = join(repo, 'smoke.sh');
    const marker = join(repo, 'marker.txt');
    await Bun.write(smoke, SMOKE);

    const planPath = join(repo, 'plan.json');
    await Bun.write(planPath, JSON.stringify(plan(`bash ${smoke} ${marker}`)));

    const r = await pleach(repo, ['run', planPath, '--repo-root', repo]);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout.trim()) as { closed: string[] }).closed).toEqual(['x']);

    // The published page is the worker's own, never the gate's mark.
    const shown = await execLocal(['git', '-C', repo, 'show', 'node/x:page.md'], repo);
    expect(shown.exitCode).toBe(0);
    expect(shown.output).toBe('done\n');
    expect(shown.output).not.toContain('[!]');

    // The journal names the restoration.
    const journal = await Bun.file(join(repo, '.git', 'pleach', 'journal.jsonl')).text();
    const restored = journal
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((e) => e.event === 'gate-writes-restored');
    expect(restored.length).toBeGreaterThan(0);
    for (const e of restored) {
      expect(e.node).toBe('x');
      expect(e.gate).toBe('smoke');
      expect(e.paths).toEqual(['page.md']);
    }
  }, 120_000);
});
