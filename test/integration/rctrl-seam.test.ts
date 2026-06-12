/**
 * Integration tests for src/seams/rctrl.ts
 *
 * Drives the REAL rctrl binary with vendored fake-claude.sh.
 * No mocks — real tmux, real rctrl state, real fake worker.
 *
 * Skip the suite when the binary is absent (loud skip).
 *
 * Env contract for fake-claude.sh (learned from rctrl/test/integration/spawn.test.ts):
 *   RCTRL_STATE           — rctrl state root (set in exec process env)
 *   RCTRL_CLAUDE_BIN      — injected by rctrl when launching; read from rctrl process env
 *   FAKE_CLAUDE_JSONL_DIR — where fake-claude writes its .jsonl (worker env via --env)
 *   FAKE_CLAUDE_HOOK      — stop.sh path derived from RCTRL_STATE (worker env via --env)
 *   FAKE_CLAUDE_DELAY     — ms to sleep before responding; explicitly set to 0 to
 *                           prevent tmux global env pollution from prior runs
 *
 * CAUTION: if FAKE_CLAUDE_DELAY is set in the tmux global environment from a prior
 * agent run, rctrl spawn.ts will inherit it and pass it to the worker, causing all
 * waits to time out. The workerEnv explicitly sets FAKE_CLAUDE_DELAY=0 to override.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerSpawnError } from '../../src/core/errors.ts';
import { exec } from '../../src/seams/exec.ts';
import type { createRctrlSeam } from '../../src/seams/rctrl.ts';
import { createRctrlSeam as makeRctrl } from '../../src/seams/rctrl.ts';

// ── binary resolution ────────────────────────────────────────────────────────

const RCTRL_BIN =
  process.env.PLEACH_RCTRL_BIN ?? '/Users/jahala/conductor/repos/.pleach-tools/rctrl';

const FAKE_CLAUDE = join(import.meta.dir, '../fixtures/fake-claude.sh');

async function binExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const binPresent = await binExists(RCTRL_BIN);

// ── test-run isolation ───────────────────────────────────────────────────────

const RUN_ID = randomBytes(3).toString('hex');

let stateDir = '';
let jsonlDir = '';

async function setupState(): Promise<void> {
  stateDir = await mkdtemp(join(tmpdir(), 'pleach-rctrl-test-'));
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

// ── seam factory ─────────────────────────────────────────────────────────────
//
// env:       process-level for every rctrl invocation (RCTRL_STATE, RCTRL_CLAUDE_BIN)
// workerEnv: forwarded as --env KEY=VAL to rctrl spawn → reaches the worker process

type Seam = ReturnType<typeof createRctrlSeam>;

function makeSeam(extra: { allowedTools?: string } = {}): Seam {
  return makeRctrl(exec, {
    ...extra,
    bin: RCTRL_BIN,
    env: {
      RCTRL_STATE: stateDir,
      RCTRL_CLAUDE_BIN: FAKE_CLAUDE,
    },
    workerEnv: {
      FAKE_CLAUDE_JSONL_DIR: jsonlDir,
      // FAKE_CLAUDE_HOOK: rctrl installs stop.sh at this path
      FAKE_CLAUDE_HOOK: join(stateDir, 'hooks', 'stop.sh'),
      // Explicitly 0 — overrides any FAKE_CLAUDE_DELAY left in tmux global env
      // by a prior test run (rctrl spawn.ts copies the full process.env to the
      // worker, which inherits tmux global env if the shell was opened from tmux).
      FAKE_CLAUDE_DELAY: '0',
    },
  });
}

// ── suite ────────────────────────────────────────────────────────────────────

describe.skipIf(!binPresent)('rctrl seam integration', () => {
  beforeAll(setupState);
  afterAll(teardownState);

  void RUN_ID; // consumed implicitly via session name uniqueness per test

  // ledger: D2 — happy path: spawn → send → wait → stop, non-empty finalMessage,
  // filesTouched array → kill
  test('happy path: spawn → send → wait(stop) → kill', async () => {
    // allowedTools rides the spawn for claude workers — the real rctrl binary
    // validates the flag path end-to-end (it would exit 2 on a non-claude
    // provider; for claude it scopes permissions so real workers don't block).
    const seam = makeSeam({ allowedTools: 'Read,Write,Edit,Bash' });
    let worker: Awaited<ReturnType<Seam['spawnWorker']>> | undefined;
    try {
      worker = await seam.spawnWorker({ cwd: '/tmp' });

      await worker.send('hello from pleach');
      const result = await worker.wait({ timeoutMs: 30_000 });

      expect(result.reason).toBe('stop');
      expect(result.finalMessage.length).toBeGreaterThan(0);
      expect(result.finalMessage).toContain('hello from pleach');
      expect(Array.isArray(result.filesTouched)).toBe(true);
      expect(result.telemetry).toBeDefined();
      // actions --json: the manifest arrives parsed, not as undefined text
      const manifest = result.actions as Record<string, unknown>;
      expect(manifest).toBeDefined();
      expect(typeof manifest.turnCount).toBe('number');
      expect(String(manifest.finalMessage)).toContain('hello from pleach');
    } finally {
      await worker?.kill();
    }
  }, 60_000);

  // ledger: D2 — two-turn conversation: second send/wait reflects turn 2
  // (--since threading prevents stale-stop: wait re-arms after each turn).
  test('two-turn conversation: sinceMtime threads correctly', async () => {
    const seam = makeSeam();
    let worker: Awaited<ReturnType<Seam['spawnWorker']>> | undefined;
    try {
      worker = await seam.spawnWorker({ cwd: '/tmp' });

      await worker.send('turn one');
      const r1 = await worker.wait({ timeoutMs: 30_000 });
      expect(r1.reason).toBe('stop');
      expect(r1.finalMessage).toContain('turn one');

      await worker.send('turn two');
      const r2 = await worker.wait({ timeoutMs: 30_000 });
      expect(r2.reason).toBe('stop');
      expect(r2.finalMessage).toContain('turn two');
    } finally {
      await worker?.kill();
    }
  }, 90_000);

  // ledger: D2 — timeout: second wait without send returns reason timeout.
  // After the first stop, sinceMtime is set to Date.now(). A second wait with
  // no new send uses that future-ish baseline — the existing stop file's mtime
  // is less than "now", so the condition never triggers → timeout.
  test('timeout: second wait without send returns reason timeout', async () => {
    const seam = makeSeam();
    let worker: Awaited<ReturnType<Seam['spawnWorker']>> | undefined;
    try {
      worker = await seam.spawnWorker({ cwd: '/tmp' });

      await worker.send('hello');
      const r1 = await worker.wait({ timeoutMs: 30_000 });
      expect(r1.reason).toBe('stop');

      // No second send — wait again with a short timeout.
      const r2 = await worker.wait({ timeoutMs: 2_000 });
      expect(r2.reason).toBe('timeout');
      expect(r2.finalMessage).toBe('');
    } finally {
      await worker?.kill();
    }
  }, 60_000);

  // ledger: D2 — dead: spawn, kill the tmux session out of band, wait → reason dead
  test('dead: killing tmux session out-of-band returns reason dead', async () => {
    const seam = makeSeam();
    let worker: Awaited<ReturnType<Seam['spawnWorker']>> | undefined;
    try {
      worker = await seam.spawnWorker({ cwd: '/tmp' });
      const name = worker.__name;

      await worker.send('a prompt');
      // Kill the tmux session directly before fake-claude can respond
      await exec(['tmux', 'kill-session', '-t', `rctrl-${name}`], {
        cwd: '/tmp',
        timeoutMs: 5000,
      });

      const result = await worker.wait({ timeoutMs: 30_000 });
      expect(result.reason).toBe('dead');
      expect(result.finalMessage).toBe('');
    } finally {
      // already dead — tolerate non-zero
      await worker?.kill().catch(() => undefined);
    }
  }, 60_000);

  // ledger: C4 — spawn failure: nonexistent --cwd → WorkerSpawnError
  test('spawn failure: nonexistent cwd throws WorkerSpawnError', async () => {
    const seam = makeSeam();
    await expect(
      seam.spawnWorker({ cwd: '/nonexistent-pleach-cwd-xyz123' }),
    ).rejects.toBeInstanceOf(WorkerSpawnError);
  }, 15_000);
});
