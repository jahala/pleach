/**
 * Integration tests for src/seams/umbel.ts
 *
 * Drives the REAL umbel binary with vendored fake-claude.sh.
 * No mocks — real tmux, real umbel state, real fake worker.
 *
 * Skip the suite when the binary is absent (loud skip).
 *
 * Env contract for fake-claude.sh (learned from umbel/test/integration/spawn.test.ts):
 *   UMBEL_STATE           — umbel state root (set in exec process env)
 *   UMBEL_CLAUDE_BIN      — injected by umbel when launching; read from umbel process env
 *   FAKE_CLAUDE_JSONL_DIR — where fake-claude writes its .jsonl (worker env via --env)
 *   FAKE_CLAUDE_HOOK      — stop.sh path derived from UMBEL_STATE (worker env via --env)
 *   FAKE_CLAUDE_DELAY     — ms to sleep before responding; explicitly set to 0 to
 *                           prevent tmux global env pollution from prior runs
 *
 * CAUTION: if FAKE_CLAUDE_DELAY is set in the tmux global environment from a prior
 * agent run, umbel spawn.ts will inherit it and pass it to the worker, causing all
 * waits to time out. The workerEnv explicitly sets FAKE_CLAUDE_DELAY=0 to override.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { createUmbelSeam } from '../../src/adapters/umbel.ts';
import { createUmbelSeam as makeUmbel } from '../../src/adapters/umbel.ts';
import { WorkerSpawnError } from '../../src/core/errors.ts';
import type { ExecFn, ExecResult } from '../../src/loop/deps.ts';
import { exec } from '../../src/seams/exec.ts';

// ── binary resolution ────────────────────────────────────────────────────────

const UMBEL_BIN = process.env.PLEACH_UMBEL_BIN ?? '';

const FAKE_CLAUDE = join(import.meta.dir, '../fixtures/fake-claude.sh');

async function binExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const binPresent = await binExists(UMBEL_BIN);

// ── test-run isolation ───────────────────────────────────────────────────────

const RUN_ID = randomBytes(3).toString('hex');

let stateDir = '';
let jsonlDir = '';

async function setupState(): Promise<void> {
  stateDir = await mkdtemp(join(tmpdir(), 'pleach-umbel-test-'));
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
// env:       process-level for every umbel invocation (UMBEL_STATE, UMBEL_CLAUDE_BIN)
// workerEnv: forwarded as --env KEY=VAL to umbel spawn → reaches the worker process

type Seam = ReturnType<typeof createUmbelSeam>;

function makeSeam(extra: { allowedTools?: string; permissionMode?: string } = {}): Seam {
  return makeUmbel(exec, {
    ...extra,
    bin: UMBEL_BIN,
    env: {
      UMBEL_STATE: stateDir,
      UMBEL_CLAUDE_BIN: FAKE_CLAUDE,
    },
    workerEnv: {
      FAKE_CLAUDE_JSONL_DIR: jsonlDir,
      // FAKE_CLAUDE_HOOK: umbel installs stop.sh at this path
      FAKE_CLAUDE_HOOK: join(stateDir, 'hooks', 'stop.sh'),
      // Explicitly 0 — overrides any FAKE_CLAUDE_DELAY left in tmux global env
      // by a prior test run (umbel spawn.ts copies the full process.env to the
      // worker, which inherits tmux global env if the shell was opened from tmux).
      FAKE_CLAUDE_DELAY: '0',
    },
  });
}

// ── suite ────────────────────────────────────────────────────────────────────

describe.skipIf(!binPresent)('umbel seam integration', () => {
  beforeAll(setupState);
  afterAll(teardownState);

  void RUN_ID; // consumed implicitly via session name uniqueness per test

  // ledger: D2 — happy path: spawn → send → wait → stop, non-empty finalMessage,
  // filesTouched array → kill
  test('happy path: spawn → send → wait(stop) → kill', async () => {
    // allowedTools + permissionMode ride the spawn for claude workers — the
    // real umbel binary validates both flag paths end-to-end. permissionMode
    // bypassPermissions is what actually keeps an autonomous worker from
    // blocking (a curated allowlist can't cover MCP tools).
    const seam = makeSeam({
      allowedTools: 'Read,Write,Edit,Bash',
      permissionMode: 'bypassPermissions',
    });
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

  // ledger: D2 — two-turn happy path: second send/wait reaches turn 2 content.
  // This test confirms the binary-level flow works but does NOT discriminate the
  // sinceMtime threading invariant (fake-claude is deterministic regardless of
  // --since). The unit-level spy test below owns that invariant.
  test('happy-path two-turn flow', async () => {
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
      await exec(['tmux', 'kill-session', '-t', `umbel-${name}`], {
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

// ── unit: sinceMtime threading (no binary required) ───────────────────────────
//
// ledger: D2 — the race-free invariant: send --json captures sinceMtime; the
// NEXT wait passes --since <that mtime>; after a 'stop' the adapter advances
// sinceMtime to Date.now() so a second wait without a new send times out rather
// than re-triggering on the same stop file.
//
// Uses a spy ExecFn (the sanctioned seam-injection pattern — createUmbelSeam
// takes exec as its first parameter). The spy is a real function, not a mock:
// it implements ExecFn correctly for every verb the adapter calls.
describe('umbel seam — sinceMtime threading (spy exec, no binary)', () => {
  const BIN = '/fake/umbel';
  const CWD = '/tmp/spy-cwd';
  const FIXED_MTIME = 123456789;

  // Build a spy ExecFn that:
  //   - spawn → success (echoes back the --name value so spawnWorker validates)
  //   - send --json → {"sinceMtime": FIXED_MTIME}
  //   - wait --json → {"reason":"stop"}
  //   - read → "spy response"
  //   - actions --json → minimal ActionManifest
  //   - diff → "" (no diff → diff field omitted)
  // All calls are appended to `calls` so assertions can inspect argv.
  function makeSpyExec(calls: Array<readonly string[]>): ExecFn {
    return async (argv): Promise<ExecResult> => {
      calls.push(argv);
      const verb = argv[1]; // argv[0] is BIN
      if (verb === 'spawn') {
        // Extract the --name value (follows '--name' flag)
        const nameIdx = argv.indexOf('--name');
        const name = nameIdx >= 0 ? argv[nameIdx + 1] : 'unknown';
        return { exitCode: 0, output: `spawned: ${name}\n` };
      }
      if (verb === 'send') {
        return { exitCode: 0, output: `{"sinceMtime":${FIXED_MTIME}}\n` };
      }
      if (verb === 'wait') {
        return { exitCode: 0, output: '{"reason":"stop"}\n' };
      }
      if (verb === 'read') {
        return { exitCode: 0, output: 'spy response\n' };
      }
      if (verb === 'actions') {
        return {
          exitCode: 0,
          output:
            '{"turnCount":1,"finalMessage":"spy response","filesEdited":[],"filesWritten":[]}\n',
        };
      }
      if (verb === 'diff') {
        return { exitCode: 0, output: '' };
      }
      if (verb === 'kill') {
        return { exitCode: 0, output: '' };
      }
      return { exitCode: 0, output: '' };
    };
  }

  test('wait argv contains --since <sinceMtime captured from send --json>', async () => {
    const calls: Array<readonly string[]> = [];
    const spyExec = makeSpyExec(calls);
    const seam = makeUmbel(spyExec, { bin: BIN });

    const worker = await seam.spawnWorker({ cwd: CWD });
    await worker.send('hello');
    await worker.wait({ timeoutMs: 5_000 });
    await worker.kill();

    // Find the wait call (verb === 'wait')
    const waitCall = calls.find((a) => a[1] === 'wait');
    expect(waitCall).toBeDefined();

    // --since must appear and its value must equal FIXED_MTIME
    const sinceIdx = (waitCall as readonly string[]).indexOf('--since');
    expect(sinceIdx).toBeGreaterThan(-1);
    expect((waitCall as readonly string[])[sinceIdx + 1]).toBe(String(FIXED_MTIME));
  });

  test('second wait (no new send) uses Date.now()-based sinceMtime, not FIXED_MTIME', async () => {
    // After a stop, sinceMtime is reset to Date.now() — the second wait must
    // NOT carry FIXED_MTIME (it must carry a fresh timestamp >= FIXED_MTIME).
    const calls: Array<readonly string[]> = [];
    const spyExec = makeSpyExec(calls);
    const seam = makeUmbel(spyExec, { bin: BIN });

    const worker = await seam.spawnWorker({ cwd: CWD });
    await worker.send('hello');
    await worker.wait({ timeoutMs: 5_000 }); // first wait: stop → sinceMtime = Date.now()
    await worker.wait({ timeoutMs: 5_000 }); // second wait: must use the Date.now() baseline
    await worker.kill();

    const waitCalls = calls.filter((a) => a[1] === 'wait');
    expect(waitCalls.length).toBe(2);

    const sinceIdx2 = (waitCalls[1] as readonly string[]).indexOf('--since');
    expect(sinceIdx2).toBeGreaterThan(-1);
    const secondSince = Number((waitCalls[1] as readonly string[])[sinceIdx2 + 1]);
    // Must be a real timestamp (> FIXED_MTIME) — not the stale send mtime.
    expect(secondSince).toBeGreaterThan(FIXED_MTIME);
  });
});
