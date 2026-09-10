/**
 * E2E: a halted run keeps the work it was holding (ledger D16), through the
 * real CLI + real git. No runner and no mocks: both plans are {command} work,
 * which is what a `pleach run` child process holds in flight most cheaply.
 *
 * Two halts, the two an operator actually performs:
 *
 *  (a) SIGINT mid-node — the hard abort. The node the run was holding settles
 *      `aborted`, not `failed`: a receipt is written, its tree is quarantined
 *      as it stands so the half-written file survives, nothing is published,
 *      and the journal says `run-aborted` before `run-end`.
 *
 *  (b) `pleach stop <plan>` from a second process — the drain. The scheduler
 *      reads the marker in the same tick as its next launch decision, so the
 *      in-flight node closes normally and its dependent never starts; the run
 *      journals `run-stopped` and consumes the marker.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepo, execLocal, gitIn } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function spawnPleach(repo: string, args: string[]) {
  return Bun.spawn(['bun', MAIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: repo,
    env: process.env,
  });
}

type PleachProc = ReturnType<typeof spawnPleach>;

async function collect(proc: PleachProc): Promise<RunResult> {
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, stdout, stderr };
}

async function pleach(repo: string, args: string[]): Promise<RunResult> {
  return collect(spawnPleach(repo, args));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Poll until the node's work has actually started, or fail loudly. */
async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(path)) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${path}`);
}

async function journalLines(repo: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(repo, '.git', 'pleach', 'journal.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const eventNames = (lines: readonly Record<string, unknown>[]): string[] =>
  lines.map((l) => String(l.event));

/** Every pleach file in the repo's git dir — lock and drain marker alike. */
async function pleachFiles(repo: string): Promise<string[]> {
  const entries = await readdir(join(repo, '.git'));
  return entries.filter((f) => f.startsWith('pleach-')).sort();
}

describe('teardown keeps the work — e2e', () => {
  let repo = '';
  let signals = '';
  let planPath = '';
  let cleanupRepo: () => Promise<void> = () => Promise.resolve();

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanupRepo = r.cleanup;
    planPath = join(repo, 'plan.json');
    // Sentinels live outside the repo: the run's own trees are the subject.
    signals = await mkdtemp(join(tmpdir(), 'pleach-teardown-'));
  });

  afterEach(async () => {
    await cleanupRepo();
    await rm(signals, { recursive: true, force: true });
  });

  // ledger: D16 — the hard abort keeps the node's work.
  test('SIGINT mid-node: aborted receipt, quarantined tree, run-aborted then run-end, exit 1', async () => {
    const started = join(signals, 'held-started');
    await writeFile(
      planPath,
      JSON.stringify({
        goal: 'a signal must not cost the node its work',
        source: 'e2e-teardown-abort',
        nodes: [
          {
            id: 'held',
            work: { command: `bash -lc "echo mid-turn > held.txt; touch ${started}; sleep 15"` },
            policy: { maxAttempts: 1 },
          },
        ],
      }),
    );

    const run = spawnPleach(repo, ['run', planPath, '--repo-root', repo]);
    await waitForFile(started, 30_000);
    run.kill('SIGINT');
    const { code, stdout } = await collect(run);

    const summary = JSON.parse(stdout.trim()) as {
      aborted: string[];
      quarantined: string[];
      closed: string[];
      failed: string[];
    };
    expect(code).toBe(1);
    expect(summary.aborted).toEqual(['held']);
    expect(summary.closed).toEqual([]);
    expect(summary.failed).toEqual([]);
    expect(summary.quarantined).toEqual(['held']);

    // The receipt: no terminal verdict without a record, halted or not.
    const receipt = JSON.parse(
      await readFile(join(repo, '.git', 'pleach', 'receipts', 'held.json'), 'utf8'),
    ) as { facts: { status: string }; derived: string };
    expect(receipt.facts.status).toBe('aborted');
    expect(receipt.derived).toBe('quarantined');

    // The work the run was holding, as it stood — and nothing published.
    expect(await gitIn(repo, 'show', 'quarantine/held:held.txt')).toBe('mid-turn');
    const nodeRefs = await execLocal(['git', '-C', repo, 'for-each-ref', 'refs/heads/node/'], repo);
    expect(nodeRefs.output.trim()).toBe('');
    expect((await gitIn(repo, 'worktree', 'list')).split('\n').length).toBe(1);

    const events = eventNames(await journalLines(repo));
    expect(events).toContain('run-aborted');
    expect(events.indexOf('run-aborted')).toBeLessThan(events.indexOf('run-end'));
  }, 120_000);

  // ledger: D16 — the drain stops the next launch, never the current node.
  test('pleach stop: the in-flight node closes, the dependent never starts, the marker is consumed', async () => {
    const started = join(signals, 'first-started');
    await writeFile(
      planPath,
      JSON.stringify({
        goal: 'a drain ends the run at a node boundary',
        source: 'e2e-teardown-stop',
        nodes: [
          {
            id: 'first',
            work: { command: `bash -lc "echo one > one.txt; touch ${started}; sleep 8"` },
            accept: { smoke: 'test -f one.txt' },
            policy: { maxAttempts: 1 },
          },
          {
            id: 'second',
            needs: ['first'],
            work: { command: 'bash -lc "echo two > two.txt"' },
            policy: { maxAttempts: 1 },
          },
        ],
      }),
    );

    const run = spawnPleach(repo, ['run', planPath, '--repo-root', repo]);
    await waitForFile(started, 30_000);

    // A second process, exactly as an operator drains a run.
    const stop = await pleach(repo, ['stop', planPath, '--repo-root', repo]);
    expect(stop.code).toBe(0);

    const { code, stdout } = await collect(run);
    const summary = JSON.parse(stdout.trim()) as {
      closed: string[];
      skipped: string[];
      failed: string[];
      aborted: string[];
    };
    expect(code).toBe(1);
    expect(summary.closed).toEqual(['first']);
    expect(summary.skipped).toEqual(['second']);
    expect(summary.failed).toEqual([]);
    expect(summary.aborted).toEqual([]);

    // The node that was in flight settled normally; the next one never spawned.
    expect(await gitIn(repo, 'show', 'node/first:one.txt')).toBe('one');
    const events = eventNames(await journalLines(repo));
    expect(events).toContain('run-stopped');
    expect(events.indexOf('run-stopped')).toBeLessThan(events.indexOf('run-end'));
    const starts = (await journalLines(repo)).filter((l) => l.event === 'node-start');
    expect(starts.map((l) => l.node)).toEqual(['first']);

    // Consumed: a marker left behind would drain the next run before it began.
    expect((await pleachFiles(repo)).filter((f) => f.endsWith('.stop'))).toEqual([]);
  }, 120_000);
});
