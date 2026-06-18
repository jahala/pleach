/**
 * E2E: the bundled examples run end-to-end through the real CLI + real git,
 * with NO external runner binary and NO API keys. Unlike the umbel full-stack
 * e2e, this runs everywhere — it is the CI proof that pleach is runnable, and
 * demonstrable, without umbel.
 *
 *  - command-dag: pure {command} nodes. Lazy worker spawn means no runner is
 *    ever spawned; proves isolation, the exit-code gate, quarantine of a failed
 *    node, and that the quarantined node's dependent is skipped.
 *  - scripted-agent: a {prompt} + cross-provider audit DAG driven by the
 *    deterministic scriptedRunner via a pleach.config.ts; proves the agent path
 *    and the cross-provider audit reach a verified close with no LLM.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createRepo } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const EXAMPLES = join(import.meta.dir, '../../examples');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function pleach(args: string[], cwd?: string): Promise<RunResult> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
    ...(cwd !== undefined ? { cwd } : {}),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, stdout, stderr };
}

async function nodeBranches(repo: string): Promise<string[]> {
  const proc = Bun.spawn(
    ['git', '-C', repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/node/'],
    { stdout: 'pipe' },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim().split('\n').filter(Boolean).sort();
}

interface Summary {
  closed: string[];
  failed: string[];
  partial: string[];
  skipped: string[];
  blocked: string[];
}

describe('examples e2e — runnable without umbel or API keys', () => {
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

  test('command-dag: closes verified nodes, quarantines the failure, skips its dependent — no runner', async () => {
    const r = await pleach(['run', join(EXAMPLES, 'command-dag/plan.json'), '--repo-root', repo]);
    const summary = JSON.parse(r.stdout.trim()) as Summary;

    expect(summary.closed.sort()).toEqual(['check', 'lib']);
    expect(summary.failed).toEqual(['broken']);
    expect(summary.skipped).toEqual(['dependent']);
    expect(r.code).toBe(1); // not every node closed — broken failed by design
    // The verified nodes are published; nothing is published for the quarantined node.
    expect(await nodeBranches(repo)).toEqual(['node/check', 'node/lib']);
  }, 60_000);

  test('scripted-agent: prompt work + cross-provider audit close via the scripted runner', async () => {
    const r = await pleach(
      [
        'run',
        join(EXAMPLES, 'scripted-agent/plan.json'),
        '--config',
        join(EXAMPLES, 'scripted-agent/pleach.config.ts'),
      ],
      repo, // cwd — gitLedger() in the config resolves its repo from the working dir
    );
    const summary = JSON.parse(r.stdout.trim()) as Summary;

    expect(summary.closed.sort()).toEqual(['harden', 'implement']);
    expect(summary.failed).toEqual([]);
    expect(summary.blocked).toEqual([]);
    expect(r.code).toBe(0);
    expect(await nodeBranches(repo)).toEqual(['node/harden', 'node/implement']);
  }, 60_000);
});
