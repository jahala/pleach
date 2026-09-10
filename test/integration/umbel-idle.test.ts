/**
 * Integration test for the idle half of src/adapters/umbel.ts — ledger D16 (3).
 *
 * Drives the REAL umbel binary with a vendored fake worker that answers once
 * and then goes quiet forever (test/fixtures/fake-claude-idle.sh). No mocks:
 * real tmux, real umbel state, real exec seam, real git worktrees.
 *
 * The defect: the adapter passes no `--idle-timeout` to `umbel wait`, so a
 * wedged worker — a codex auditor idle on a 404 — rides the whole attempt
 * clock and the operator is the idle detector. umbel already knows how to end
 * such a wait (`--idle-timeout`, exit 0, `{"reason":"idle"}`); nobody asks it
 * to. The ask is a conductor default (`--idle-ms`) threaded down as
 * `Worker.wait`'s `idleMs` — a policy the conductor owns, not a plan field and
 * not a number the adapter invents.
 *
 * Both halves are here because either alone is a half-truth: the flag must
 * reach umbel AND the idle it returns must settle the node the way a blocked
 * worker settles — tree quarantined, nothing published.
 *
 * Env contract for the fake worker (see test/integration/umbel-seam.test.ts):
 *   UMBEL_STATE           — umbel state root (exec process env)
 *   UMBEL_CLAUDE_BIN      — the fake binary umbel launches (exec process env)
 *   FAKE_CLAUDE_JSONL_DIR — where the fake writes its .jsonl (worker env via --env)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitLedger } from '../../src/adapters/git.ts';
import type { createUmbelSeam } from '../../src/adapters/umbel.ts';
import { createUmbelSeam as makeUmbel } from '../../src/adapters/umbel.ts';
import type { Plan } from '../../src/core/plan.ts';
import { buildDeps } from '../../src/faces/config.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { exec } from '../../src/seams/exec.ts';
import { createRepo, execLocal, gitIn } from '../support/git-repo.ts';

// ── binary resolution ────────────────────────────────────────────────────────
//
// PLEACH_UMBEL_BIN first, then umbel on PATH — the same ladder src/faces/cli.ts
// uses. CI has neither umbel nor tmux and skips loudly.

const UMBEL_BIN = process.env.PLEACH_UMBEL_BIN ?? Bun.which('umbel') ?? '';

const FAKE_CLAUDE_IDLE = join(import.meta.dir, '../fixtures/fake-claude-idle.sh');

// The worker goes quiet after one line. IDLE_MS is what the conductor asks umbel
// to watch for; ATTEMPT_MS is the clock the wait would otherwise ride to.
const IDLE_MS = 2_000;
const ATTEMPT_MS = 60_000;

async function binExists(p: string): Promise<boolean> {
  if (p === '') return false;
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const binPresent = await binExists(UMBEL_BIN);

// ── test-run isolation ───────────────────────────────────────────────────────

let stateDir = '';
let jsonlDir = '';

async function setupState(): Promise<void> {
  stateDir = await mkdtemp(join(tmpdir(), 'pleach-umbel-idle-'));
  jsonlDir = join(stateDir, 'fake-jsonl');
  await mkdir(jsonlDir, { recursive: true });
}

async function teardownState(): Promise<void> {
  if (stateDir) {
    await rm(stateDir, { recursive: true, force: true });
    stateDir = '';
    jsonlDir = '';
  }
}

type Seam = ReturnType<typeof createUmbelSeam>;
type SpawnedWorker = Awaited<ReturnType<Seam['spawnWorker']>>;

function makeSeam(): Seam {
  return makeUmbel(exec, {
    bin: UMBEL_BIN,
    env: {
      UMBEL_STATE: stateDir,
      UMBEL_CLAUDE_BIN: FAKE_CLAUDE_IDLE,
    },
    workerEnv: {
      FAKE_CLAUDE_JSONL_DIR: jsonlDir,
    },
  });
}

// ── the adapter ──────────────────────────────────────────────────────────────

describe.skipIf(!binPresent)('umbel seam — the idle timeout (ledger D16)', () => {
  beforeAll(setupState);
  afterAll(teardownState);

  // ledger: D16 — the wait's idleMs reaches umbel: a worker that goes quiet
  // ends at the idle timeout, not at the attempt clock thirty times further out.
  test('a wait given idleMs ends a quiet worker at the idle timeout', async () => {
    const seam = makeSeam();
    let worker: SpawnedWorker | undefined;
    try {
      worker = await seam.spawnWorker({ cwd: stateDir });
      await worker.send('start something and then say nothing');

      const startedAt = Date.now();
      const result = await worker.wait({ timeoutMs: ATTEMPT_MS, idleMs: IDLE_MS });
      const elapsedMs = Date.now() - startedAt;

      expect(result.reason).toBe('idle');
      // The idle timeout ended it, not umbel's hard deadline.
      expect(elapsedMs).toBeLessThan(20_000);
      // A blocking reason gathers nothing (the worker is still sitting there) —
      // every field the loop reads is present all the same.
      expect(result.finalMessage).toBe('');
      expect(result.filesTouched).toEqual([]);
      expect(result.telemetry).toBeDefined();
    } finally {
      await worker?.kill().catch(() => undefined);
    }
  }, 120_000);

  // ledger: D16 — the negative, and the reason the flag is threaded rather than
  // baked in: with no idleMs the same quiet worker rides its attempt clock to
  // the hard deadline. The adapter invents no default of its own — the idle
  // policy belongs to the conductor.
  test('a wait with no idleMs rides the attempt clock to timeout', async () => {
    const seam = makeSeam();
    let worker: SpawnedWorker | undefined;
    try {
      worker = await seam.spawnWorker({ cwd: stateDir });
      await worker.send('start something and then say nothing');

      const result = await worker.wait({ timeoutMs: 6_000 });

      expect(result.reason).toBe('timeout');
    } finally {
      await worker?.kill().catch(() => undefined);
    }
  }, 120_000);
});

// ── through the loop ─────────────────────────────────────────────────────────

describe.skipIf(!binPresent)('runPlan over the umbel runner — a wedged worker (D16)', () => {
  let repo = '';
  let cleanupRepo: () => Promise<void> = () => Promise.resolve();

  beforeEach(async () => {
    await setupState();
    const r = await createRepo();
    repo = r.path;
    cleanupRepo = r.cleanup;
  });

  afterEach(async () => {
    await cleanupRepo();
    await teardownState();
  });

  // ledger: D16 — the conductor's idle default threaded end to end: runPlan's
  // idleMs reaches every worker wait, umbel answers `idle`, and the existing
  // idle → blocked mapping settles the node with its half-done tree kept on
  // quarantine/<id>. Nothing is published; nothing is lost.
  test('a node whose worker goes quiet settles blocked with its tree quarantined', async () => {
    const plan: Plan = {
      goal: 'a worker that goes quiet must not ride the attempt clock',
      source: 'umbel-idle',
      nodes: [
        {
          id: 'quiet',
          worker: {},
          work: { prompt: 'start something and then say nothing' },
          needs: [],
          accept: {},
          policy: { maxAttempts: 1, onDead: 'fail', reauditWhen: [], timeoutMs: ATTEMPT_MS },
          closes: [],
        },
      ],
    };

    const deps = buildDeps({
      repoRoot: repo,
      runner: makeSeam(),
      ledger: gitLedger({ repo }),
      journal: join(stateDir, 'journal.jsonl'),
    });

    const summary = await runPlan(plan, deps, {
      repoRoot: repo,
      defaultTimeoutMs: ATTEMPT_MS,
      idleMs: IDLE_MS,
    });

    expect(summary.blocked).toEqual(['quiet']);
    expect(summary.failed).toEqual([]);
    expect(summary.closed).toEqual([]);

    // The work the worker had started is kept, un-published.
    expect(summary.quarantined).toEqual(['quiet']);
    expect(await gitIn(repo, 'show', 'quarantine/quiet:idle-work.txt')).toBe('started work');
    const nodeRefs = await execLocal(['git', '-C', repo, 'for-each-ref', 'refs/heads/node/'], repo);
    expect(nodeRefs.output.trim()).toBe('');
    // No worktree leaked.
    expect((await gitIn(repo, 'worktree', 'list')).split('\n').length).toBe(1);
  }, 180_000);
});
