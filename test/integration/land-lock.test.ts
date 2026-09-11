/**
 * Integration: the lock `landPlan` holds, against the real lock seam and real
 * processes (ledger D18).
 *
 * A landing writes the base branch; a run writes its own state. They never
 * write the same thing, so a landing must not queue behind the RUN's lock — it
 * takes one of its own beside it (`<lock>.land`), and only another landing can
 * refuse it. A refusal names the holder's pid and which lock it holds, because
 * "lock held" without a holder is a dead end for the operator.
 *
 * The lock seam and both holders are real (test/fixtures/hold-lock.ts, the same
 * seam a run takes its lock through); the ledger and isolate are the in-memory
 * seams a loop test composes, so nothing but the locking is under test here.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LockHeldError } from '../../src/core/errors.ts';
import { PlanSchema } from '../../src/core/plan.ts';
import type { ConductorDeps, JournalSeam } from '../../src/loop/deps.ts';
import { landPlan } from '../../src/loop/land.ts';
import { createLockSeam } from '../../src/seams/lock.ts';
import { type Harness, makeHarness } from '../loop/harness.ts';
import { createRepo } from '../support/git-repo.ts';

const HOLD_LOCK = join(import.meta.dir, '../fixtures/hold-lock.ts');

const SOURCE = 'integration-land-lock-source';
// The names the seam gives this (repoRoot, source), computed here rather than
// read from the seam: the pairing IS the contract — the landing's lock is the
// run's name plus `.land`, so the two are found together and never drift.
const RUN_LOCK = `pleach-${createHash('sha1').update(SOURCE).digest('hex').slice(0, 12)}.lock`;
const LAND_LOCK = `${RUN_LOCK}.land`;

// One verified sink, resolvable through the baseRef chain — enough plan for a
// landing to reach the seam; the composition gate is empty (no smoke).
const PLAN = PlanSchema.parse({
  goal: 'a plan whose sink is verified and ready to land',
  source: SOURCE,
  nodes: [{ id: 'a', work: { command: 'true' } }],
});

type Holder = ReturnType<typeof Bun.spawn>;

/** Start a holder of one of the two locks; return once it is on disk. */
async function startHolder(repo: string, which: 'run' | 'land'): Promise<Holder> {
  const proc = Bun.spawn(['bun', HOLD_LOCK, repo, SOURCE, which], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const reader = proc.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  const line = new TextDecoder().decode(first.value ?? new Uint8Array());
  if (!line.includes('held')) {
    throw new Error(`hold-lock fixture did not take the ${which} lock: ${line}`);
  }
  return proc;
}

/** Every pleach lockfile in the repo's git dir, name → the pid it names. */
async function lockFiles(repo: string): Promise<Record<string, number | null>> {
  const dir = join(repo, '.git');
  const names = (await readdir(dir)).filter((f) => f.startsWith('pleach-')).sort();
  const found: Record<string, number | null> = {};
  for (const name of names) {
    const pid = Number((await readFile(join(dir, name), 'utf8')).trim());
    found[name] = Number.isFinite(pid) && pid > 0 ? pid : null;
  }
  return found;
}

interface Landing {
  h: Harness;
  deps: ConductorDeps;
  /** The lockfiles as they stood at the moment the landing started. */
  during: Record<string, number | null>;
}

/**
 * The loop harness with the REAL lock seam swapped in, and a journal that
 * photographs the lock directory when the landing starts — the only moment at
 * which "which lock does a landing hold" can be answered.
 */
function landing(repo: string): Landing {
  const h = makeHarness({
    closed: new Map([['a', 'sha-a']]),
    refs: { 'node/a': 'sha-a' },
  });
  const during: Record<string, number | null> = {};
  const watched: JournalSeam = {
    async append(event) {
      if (event.event === 'land-start') Object.assign(during, await lockFiles(repo));
      await h.deps.journal.append(event);
    },
    verdictNodes: () => h.deps.journal.verdictNodes(),
    linesSince: (runId) => h.deps.journal.linesSince(runId),
  };
  return { h, deps: { ...h.deps, lock: createLockSeam(), journal: watched }, during };
}

describe("landPlan — its own lock, beside the run's", () => {
  let repo = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();
  const holders: Holder[] = [];

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanup = r.cleanup;
  });

  afterEach(async () => {
    for (const holder of holders) {
      if (holder.exitCode === null) {
        holder.kill('SIGKILL');
        await holder.exited;
      }
    }
    holders.length = 0;
    await cleanup();
  });

  test('D18: a landing proceeds while a live run holds the run lock', async () => {
    const run = await startHolder(repo, 'run');
    holders.push(run);
    const { h, deps, during } = landing(repo);

    const summary = await landPlan(PLAN, deps, { repoRoot: repo });

    expect(summary.landed).toEqual(['a']);
    // Both locks were held at once, each by its own holder: the run's still
    // names the run — the landing never took it — and the land lock is ours.
    expect(during[RUN_LOCK]).toBe(run.pid);
    expect(during[LAND_LOCK]).toBe(process.pid);
    expect(h.log.count('land')).toBe(1);
    // A landing is not a stop: the run rides on.
    expect(run.exitCode).toBeNull();
  }, 20000);

  test('D18: the landing holds only the land lock, and releases it', async () => {
    const { deps, during } = landing(repo);

    await landPlan(PLAN, deps, { repoRoot: repo });

    expect(Object.keys(during)).toEqual([LAND_LOCK]);
    // Released — a landing that kept its lock would block every later one.
    expect(await lockFiles(repo)).toEqual({});
  }, 20000);

  test('D18: landings serialise — the next one takes the land lock in turn', async () => {
    await landPlan(PLAN, landing(repo).deps, { repoRoot: repo });

    const second = landing(repo);
    await landPlan(PLAN, second.deps, { repoRoot: repo });

    expect(second.during[LAND_LOCK]).toBe(process.pid);
  }, 20000);

  test('D18: a live landing refuses the next, naming the pid and the land lock', async () => {
    const other = await startHolder(repo, 'land');
    holders.push(other);
    const { h, deps } = landing(repo);

    const refusal: unknown = await landPlan(PLAN, deps, { repoRoot: repo }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(refusal).toBeInstanceOf(LockHeldError);
    const err = refusal as LockHeldError;
    expect(err.pid).toBe(other.pid);
    expect(err.message).toContain(`land lock held by pid ${other.pid}`);
    expect(err.path.endsWith('.lock.land')).toBe(true);
    // Refused before anything was built or published.
    expect(h.log.count('landStack')).toBe(0);
    expect(h.journal.some((e) => e.event === 'landed')).toBe(false);
  }, 20000);

  test('D18: a refusal names which lock it is — run or land', async () => {
    const lock = createLockSeam();
    const run = await lock.acquire(repo, SOURCE);
    const land = await lock.acquireLand(repo, SOURCE);
    try {
      const runAgain: unknown = await lock.acquire(repo, SOURCE).catch((err: unknown) => err);
      const landAgain: unknown = await lock.acquireLand(repo, SOURCE).catch((err: unknown) => err);

      expect((runAgain as LockHeldError).message).toContain(`run lock held by pid ${process.pid}`);
      expect((landAgain as LockHeldError).message).toContain(
        `land lock held by pid ${process.pid}`,
      );
    } finally {
      await land.release();
      await run.release();
    }
  }, 20000);

  test('D18: a stale land lock (a dead pid) is taken over', async () => {
    const deadPid = 999999;
    let dead = false;
    try {
      process.kill(deadPid, 0);
    } catch {
      dead = true;
    }
    expect(dead).toBe(true);
    await writeFile(join(repo, '.git', LAND_LOCK), String(deadPid), 'utf8');

    const { deps, during } = landing(repo);
    const summary = await landPlan(PLAN, deps, { repoRoot: repo });

    expect(summary.landed).toEqual(['a']);
    expect(during[LAND_LOCK]).toBe(process.pid);
    expect(await lockFiles(repo)).toEqual({});
  }, 20000);
});
