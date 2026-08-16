/**
 * E2E: case 0 of examples/three-ways — the deterministic guardrail.
 *
 * Runs the EXACT payload plan (examples/three-ways/payload/plan.json) through
 * the real CLI + real git + the bundled scriptedRunner (canned writes, no
 * agent, no keys — test/fixtures/three-ways-scripted.config.ts). This is the
 * part of the three-ways story that cannot silently rot in CI; profiles 1–3
 * are the same plan with real agents swapped in.
 *
 * What it battle-tests beyond examples.test.ts: a REAL conflicted merge. Both
 * engine nodes edit src/ttt.ts and test/ttt.test.ts, so the integration node's
 * isolate commits conflict markers, surfaces the files in the prompt, and the
 * gates verify the resolution before node/ttt publishes.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { createRepo, gitIn } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const PAYLOAD = join(import.meta.dir, '../../examples/three-ways/payload');
const CONFIG = join(import.meta.dir, '../fixtures/three-ways-scripted.config.ts');

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

interface Summary {
  closed: string[];
  failed: string[];
  partial: string[];
  skipped: string[];
  blocked: string[];
}

describe('three-ways case 0 — payload plan through the scripted runner', () => {
  let repo = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanup = r.cleanup;
    // Seed the shared payload project (same seeding as the profiles' run.sh).
    await cp(join(PAYLOAD, 'project'), repo, { recursive: true });
    await gitIn(repo, 'add', '-A');
    await gitIn(repo, 'commit', '-m', 'seed: ttt project');
  });

  afterEach(async () => {
    await cleanup();
  });

  test('verified close: conflicted merge resolved, gates green, three branches', async () => {
    const r = await pleach(
      [
        'run',
        join(PAYLOAD, 'plan.json'),
        '--config',
        CONFIG,
        '--repo-root',
        repo,
        '--max-concurrency',
        '2',
      ],
      repo, // cwd — gitLedger() in the config resolves its repo from the working dir
    );
    const summary = JSON.parse(r.stdout.trim()) as Summary;

    // Full verified close, exit 0.
    expect(summary.closed.sort()).toEqual(['ttt', 'ttt.s1', 'ttt.s2']);
    expect(summary.failed).toEqual([]);
    expect(summary.partial).toEqual([]);
    expect(summary.blocked).toEqual([]);
    expect(r.code).toBe(0);

    // All three node branches published.
    const branches = await gitIn(
      repo,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/node/',
    );
    expect(branches.split('\n').sort()).toEqual(['node/ttt', 'node/ttt.s1', 'node/ttt.s2']);

    // The conflicted-merge path REALLY ran: isolate committed the markers with
    // its canonical message before the integration scenario resolved them.
    const log = await gitIn(repo, 'log', '--format=%s', 'node/ttt');
    expect(log).toContain('conflicts kept as markers');

    // The published tree is the honest union — every engine function present,
    // no conflict markers survived to the verified branch (ledger C1).
    const engine = await gitIn(repo, 'show', 'node/ttt:src/ttt.ts');
    for (const fn of ['emptyBoard', 'legalMoves', 'applyMove', 'winner', 'status']) {
      expect(engine).toContain(`export function ${fn}`);
    }
    expect(engine).not.toContain('<<<<<<<');

    // The deliverable exists on the verified branch and is self-contained.
    const html = await gitIn(repo, 'show', 'node/ttt:index.html');
    expect(html).toContain('<script>');
    expect(html).not.toContain("from './");
  }, 180_000);
});
