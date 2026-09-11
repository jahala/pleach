// Integration: every run leaves a copy of its own journal lines beside the
// receipts (ledger D21, jahala/pleach#97). The stem's journal lost nineteen
// nodes between two runs while the receipts beside it survived: one unguarded
// file was the record of record. At `run-end` the run's lines, from its
// `run-start` to that `run-end`, are copied to
// `<git-dir>/pleach/receipts/runs/<run-id>.journal.jsonl`, and the `run-end`
// line names the copy, so the ledger can be rebuilt from what is kept beside
// the receipts. Real git in a tmp dir, the seams wired the way the CLI wires
// them; the worker is a real RunnerSeam that writes its delivery and stops.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitLedger } from '../../src/adapters/git.ts';
import { PlanSchema } from '../../src/core/plan.ts';
import { buildDeps } from '../../src/faces/config.ts';
import type { RunnerSeam } from '../../src/loop/deps.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { resolveGitDir } from '../../src/seams/gitdir.ts';
import { createJournal } from '../../src/seams/journal.ts';
import { createRepo } from '../support/git-repo.ts';

const SOURCE = 'run-journal-copy';
const CRASHED = 'a run that never reached run-end';

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

function planFor(id: string) {
  return PlanSchema.parse({
    goal: `build ${id}`,
    source: SOURCE,
    nodes: [{ id, work: { prompt: `build ${id}` }, policy: { maxAttempts: 1 } }],
  });
}

// A real RunnerSeam: the worker writes its delivery into the worktree it was
// given and hands it back.
function writingRunner(): RunnerSeam {
  return {
    async spawnWorker(spec) {
      return {
        async send() {},
        async wait() {
          await writeFile(join(spec.cwd, 'work.txt'), 'built\n');
          return {
            finalMessage: 'built it',
            filesTouched: ['work.txt'],
            reason: 'stop' as const,
            telemetry: {},
          };
        },
        async kill() {},
      };
    },
  };
}

// ledger: D21
test('two runs back to back leave two copies, each exactly its own run-start to run-end, named by run-end', async () => {
  const pleachDir = join(resolveGitDir(repo), 'pleach');
  const journalPath = join(pleachDir, 'journal.jsonl');
  const runsDir = join(pleachDir, 'receipts', 'runs');

  // The journal already holds an earlier run that died before its run-end:
  // no copy of it is made, and none of its lines belong to the runs below.
  const earlier = createJournal(journalPath);
  await earlier.append({ event: 'run-start', goal: CRASHED, nodes: 1 });
  await earlier.append({ event: 'node-start', node: 'lost' });

  const plans = [planFor('first'), planFor('second')];
  for (const plan of plans) {
    const deps = buildDeps({
      repoRoot: repo,
      runner: writingRunner(),
      ledger: gitLedger({ repo }),
    });
    const summary = await runPlan(plan, deps, { repoRoot: repo, defaultTimeoutMs: 60_000 });
    expect(summary.closed).toEqual([plan.nodes[0]?.id as string]);
  }

  const text = await readFile(journalPath, 'utf8');
  const lines = text.split('\n').filter((l) => l !== '');
  const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);

  const runIds: string[] = [];
  for (const plan of plans) {
    const start = events.findIndex((e) => e.event === 'run-start' && e.goal === plan.goal);
    const end = events.findIndex((e, i) => i > start && e.event === 'run-end');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    // The run-start names the run, in a form that is a filename.
    const runId = events[start]?.runId;
    expect(typeof runId).toBe('string');
    expect(runId as string).toMatch(/^[A-Za-z0-9._-]+$/);
    runIds.push(runId as string);

    // The run-end names the copy, and the copy is there.
    const copyPath = join(runsDir, `${runId as string}.journal.jsonl`);
    expect(events[end]?.journalCopy).toBe(copyPath);
    const copy = await readFile(copyPath, 'utf8');

    // Exactly this run's lines as the journal holds them: from its run-start
    // to its run-end, the run-end naming the copy included, nothing before or
    // after.
    const own = lines.slice(start, end + 1);
    expect(copy).toBe(own.map((l) => `${l}\n`).join(''));
  }

  // Two runs, two copies, in run order; the crashed run left none.
  const [firstId, secondId] = runIds as [string, string];
  expect(firstId < secondId).toBe(true);
  expect((await readdir(runsDir)).sort()).toEqual([
    `${firstId}.journal.jsonl`,
    `${secondId}.journal.jsonl`,
  ]);
});

// ledger: D21 — the loss the copy exists for can happen mid-run. A journal
// that no longer holds this run's run-start cannot be copied from it: a copy
// without its start would claim a whole run it never saw. So no copy is made,
// the line after run-end says so, and the run's closes stand.
test('a journal lost mid-run leaves no copy, a journal-copy-failed line after run-end, and the run stands', async () => {
  const pleachDir = join(resolveGitDir(repo), 'pleach');
  const journalPath = join(pleachDir, 'journal.jsonl');
  const losing: RunnerSeam = {
    async spawnWorker(spec) {
      const worker = await writingRunner().spawnWorker(spec);
      return {
        ...worker,
        async wait(opts) {
          await unlink(journalPath);
          return worker.wait(opts);
        },
      };
    },
  };
  const deps = buildDeps({ repoRoot: repo, runner: losing, ledger: gitLedger({ repo }) });

  const summary = await runPlan(planFor('first'), deps, {
    repoRoot: repo,
    defaultTimeoutMs: 60_000,
  });

  expect(summary.closed).toEqual(['first']);
  const events = (await readFile(journalPath, 'utf8'))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(events.some((e) => e.event === 'run-start')).toBe(false);
  const end = events.findIndex((e) => e.event === 'run-end');
  expect(end).toBeGreaterThan(-1);
  const failed = events.slice(end + 1);
  expect(failed.map((e) => e.event)).toEqual(['journal-copy-failed']);
  expect(failed[0]?.journalCopy).toBe(events[end]?.journalCopy);
  expect(failed[0]?.detail).toContain('run-start');
  expect(await readdir(join(pleachDir, 'receipts', 'runs')).catch(() => [])).toEqual([]);
});
