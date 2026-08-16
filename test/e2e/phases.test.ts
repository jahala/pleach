/**
 * E2E: the {test, phases} TDD work mode through the real CLI + real git, with
 * the scripted runner and REAL gate execution (run-work executes `work.test`
 * in the worktree after the red and green phases — no LLM, runs in CI).
 *
 * Two sides of the guarantee:
 *  - honest cycle (red fails → impl → green passes) reaches a verified close;
 *  - a cheating red phase (test already passes — no failing spec was ever
 *    demonstrated) MUST fail the node: exit 1, no node/<id> branch, work
 *    quarantined. The TDD gate discriminates, mechanically.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRepo, execLocal, gitIn } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const CONFIG = join(import.meta.dir, '../fixtures/phases-scripted.config.ts');

// The seed: add() exists but is WRONG — a genuinely failing test can exist.
const CALC_SEED = `export function add(a: number, b: number): number {
  return 0;
}
`;

function phasesPlan(kind: 'HONEST' | 'CHEAT') {
  return {
    goal: `phases proof (${kind})`,
    source: `e2e-phases-${kind}`,
    nodes: [
      {
        id: 'calc',
        work: {
          test: 'bun test calc.test.ts',
          phases: [
            { phase: 'red', prompt: `${kind}-RED: write a failing test for add()` },
            { phase: 'impl', prompt: `${kind}-IMPL: make the test pass` },
            { phase: 'green', prompt: `${kind}-GREEN: confirm the suite` },
          ],
        },
        accept: { smoke: 'bun test calc.test.ts' },
        policy: { maxAttempts: 1 },
      },
    ],
  };
}

async function pleachRun(repo: string, plan: unknown): Promise<{ code: number; stdout: string }> {
  const planPath = join(repo, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  const proc = Bun.spawn(['bun', MAIN, 'run', planPath, '--config', CONFIG, '--repo-root', repo], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: repo,
    env: process.env,
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code: code ?? 1, stdout };
}

describe('phases — the TDD cycle with real gates', () => {
  let repo = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanup = r.cleanup;
    await writeFile(join(repo, 'calc.ts'), CALC_SEED);
    await gitIn(repo, 'add', 'calc.ts');
    await gitIn(repo, 'commit', '-m', 'seed: broken add()');
  });

  afterEach(async () => {
    await cleanup();
  });

  test('honest red→impl→green closes verified; the fix is on node/calc', async () => {
    const r = await pleachRun(repo, phasesPlan('HONEST'));
    const summary = JSON.parse(r.stdout.trim()) as { closed: string[]; failed: string[] };

    expect(summary.failed).toEqual([]);
    expect(summary.closed).toEqual(['calc']);
    expect(r.code).toBe(0);
    expect(await gitIn(repo, 'show', 'node/calc:calc.ts')).toContain('return a + b;');
    expect(await gitIn(repo, 'show', 'node/calc:calc.test.ts')).toContain('toBe(5)');
  }, 60_000);

  test('a red phase whose test already passes fails the node — no branch, work quarantined', async () => {
    const r = await pleachRun(repo, phasesPlan('CHEAT'));
    const summary = JSON.parse(r.stdout.trim()) as {
      closed: string[];
      failed: string[];
      quarantined: string[];
    };

    expect(summary.closed).toEqual([]);
    expect(summary.failed).toEqual(['calc']);
    expect(summary.quarantined).toEqual(['calc']);
    expect(r.code).toBe(1);

    // Nothing published as verified; the cheat evidence is inspectable.
    const nodeRefs = await execLocal(['git', '-C', repo, 'for-each-ref', 'refs/heads/node/'], repo);
    expect(nodeRefs.output.trim()).toBe('');
    expect(await gitIn(repo, 'show', 'quarantine/calc:calc.test.ts')).toContain('toBe(0)');
  }, 60_000);
});
