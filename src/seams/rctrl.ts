import { WorkerSeamError, WorkerSpawnError } from '../core/errors.ts';
import type { ExecFn, Worker, WorkerResult } from '../loop/deps.ts';

// ── createRctrlSeam ──────────────────────────────────────────────────────────
//
// Drives the rctrl binary over ExecFn. Each verb is an arg-array invocation;
// ExecFn never rejects (spawn failure → exitCode 127).
//
// Per-worker sinceMtime threads send→wait correctly (race-free stop detection).

export interface RctrlSeamOpts {
  bin: string;
  // Process-level env for every rctrl invocation (RCTRL_STATE etc.).
  env?: Record<string, string>;
  // Extra env vars passed as --env KEY=VAL to rctrl spawn — reach the worker.
  // Use for FAKE_CLAUDE_* in tests; production typically leaves this empty.
  workerEnv?: Record<string, string>;
  // Tool allowlist for spawned workers. Real claude workers hit permission
  // prompts without it (reason 'input' → the node blocks). Passed only when
  // the resolved provider is claude — rctrl rejects it for codex/gemini/
  // opencode by design (their work-or-error guard), so the auditor on codex
  // spawns without scoping (v1 limitation, documented).
  allowedTools?: string;
}

// The concrete return type is structurally compatible with RctrlSeam; the
// inferred type exposes the extra __name field on workers for test access.
export function createRctrlSeam(exec: ExecFn, opts: RctrlSeamOpts) {
  const { bin, env: seamEnv = {}, workerEnv: seamWorkerEnv = {}, allowedTools } = opts;

  // Merge seam-level env into every exec call.
  function mergeEnv(extra?: Record<string, string>): Record<string, string> {
    return extra !== undefined ? { ...seamEnv, ...extra } : { ...seamEnv };
  }

  // ── spawnWorker ─────────────────────────────────────────────────────────────

  async function spawnWorker(spec: {
    provider?: string;
    model?: string;
    cwd: string;
  }): Promise<Worker & { __name: string }> {
    const name = `pl-${randomHex(8)}`;

    const argv: string[] = [bin, 'spawn', '--name', name, '--cwd', spec.cwd];
    if (spec.provider !== undefined) argv.push('--provider', spec.provider);
    if (spec.model !== undefined) argv.push('--model', spec.model);
    if (allowedTools !== undefined && (spec.provider ?? 'claude') === 'claude') {
      argv.push('--allowed-tools', allowedTools);
    }
    // Pass per-worker env vars as --env KEY=VAL flags (reaches the worker process).
    for (const [k, v] of Object.entries(seamWorkerEnv)) {
      argv.push('--env', `${k}=${v}`);
    }

    const result = await exec(argv, { cwd: spec.cwd, env: mergeEnv() });

    if (result.exitCode !== 0) {
      throw new WorkerSpawnError(`rctrl spawn exited ${result.exitCode}: ${result.output.trim()}`);
    }

    // stdout: "spawned: <name>\n" — verify the name appears
    if (!result.output.includes(name)) {
      throw new WorkerSpawnError(
        `rctrl spawn succeeded but name not found in output: ${result.output.trim()}`,
      );
    }

    return createWorker(name, spec.cwd);
  }

  // ── createWorker ─────────────────────────────────────────────────────────────

  function createWorker(name: string, cwd: string): Worker & { __name: string } {
    // sinceMtime captured from send --json; threaded into the next wait call.
    let sinceMtime: number | undefined;

    // ── send ──────────────────────────────────────────────────────────────────

    async function send(text: string): Promise<void> {
      const result = await exec([bin, 'send', '--json', name, text], { cwd, env: mergeEnv() });

      if (result.exitCode !== 0) {
        throw new WorkerSeamError(`send exited ${result.exitCode}: ${result.output.trim()}`);
      }

      // stdout: {"sinceMtime": N}\n
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.output.trim());
      } catch {
        throw new WorkerSeamError(
          `send --json produced unparseable output: ${result.output.trim()}`,
        );
      }

      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as Record<string, unknown>).sinceMtime !== 'number'
      ) {
        throw new WorkerSeamError(`send --json missing sinceMtime field: ${result.output.trim()}`);
      }

      sinceMtime = (parsed as { sinceMtime: number }).sinceMtime;
    }

    // ── wait ──────────────────────────────────────────────────────────────────

    async function wait(waitOpts?: { timeoutMs?: number }): Promise<WorkerResult> {
      const argv: string[] = [bin, 'wait', '--json'];

      if (sinceMtime !== undefined) {
        argv.push('--since', String(sinceMtime));
      }

      if (waitOpts?.timeoutMs !== undefined) {
        argv.push('--timeout', `${waitOpts.timeoutMs}ms`);
      }

      argv.push(name);

      // Give exec headroom beyond rctrl's own timeout so ExecFn doesn't race.
      const execTimeout =
        waitOpts?.timeoutMs !== undefined ? waitOpts.timeoutMs + 10_000 : undefined;

      const result = await exec(argv, { cwd, env: mergeEnv(), timeoutMs: execTimeout });

      if (result.exitCode !== 0) {
        throw new WorkerSeamError(`wait exited ${result.exitCode}: ${result.output.trim()}`);
      }

      // stdout: {"reason": "...", "message"?: "..."}\n
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.output.trim());
      } catch {
        throw new WorkerSeamError(
          `wait --json produced unparseable output: ${result.output.trim()}`,
        );
      }

      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as Record<string, unknown>).reason !== 'string'
      ) {
        throw new WorkerSeamError(`wait --json missing reason field: ${result.output.trim()}`);
      }

      const waitJson = parsed as { reason: string; message?: string };
      const reason = waitJson.reason as WorkerResult['reason'];

      // After consuming a stop, mark "now" as the new baseline so a subsequent
      // wait without a new send won't immediately re-trigger on the same stop
      // event (mtime > sinceMtime would be satisfied by the existing stop file).
      // A new send overwrites sinceMtime with the pre-send snapshot.
      sinceMtime = reason === 'stop' ? Date.now() : undefined;

      return gatherWorkerResult(name, cwd, reason, waitJson.message);
    }

    // ── kill ──────────────────────────────────────────────────────────────────

    async function kill(): Promise<void> {
      // Tolerate non-zero — already dead is fine (ledger: kill semantics).
      await exec([bin, 'kill', name], { cwd, env: mergeEnv(), timeoutMs: 10_000 });
    }

    return { send, wait, kill, __name: name };
  }

  // ── gatherWorkerResult ────────────────────────────────────────────────────
  //
  // Assembles WorkerResult from the wait reason + subsidiary rctrl verbs.
  // Only 'stop' warrants the read/actions/diff roundtrips.

  async function gatherWorkerResult(
    name: string,
    cwd: string,
    reason: WorkerResult['reason'],
    message: string | undefined,
  ): Promise<WorkerResult> {
    // Blocking reasons: worker held at a prompt — carry message, no read/diff.
    if (reason === 'input' || reason === 'idle') {
      return { reason, finalMessage: '', filesTouched: [], message, telemetry: {} };
    }

    // Terminal non-stop: dead / timeout / aborted.
    if (reason !== 'stop') {
      return { reason, finalMessage: '', filesTouched: [], telemetry: {} };
    }

    // ── stop: read + actions + diff ──────────────────────────────────────────

    // rctrl read — last assistant message, untruncated (ledger C4).
    const readResult = await exec([bin, 'read', name], {
      cwd,
      env: mergeEnv(),
      timeoutMs: 30_000,
    });
    const finalMessage = readResult.exitCode === 0 ? readResult.output.trim() : '';

    // rctrl actions --json — the raw ActionManifest (toolsUsed, files*, errors,
    // finalMessage, turnCount). Unparseable/failed → actions = undefined.
    const actionsResult = await exec([bin, 'actions', '--json', name], {
      cwd,
      env: mergeEnv(),
      timeoutMs: 30_000,
    });
    let actions: unknown;
    if (actionsResult.exitCode === 0) {
      try {
        actions = JSON.parse(actionsResult.output.trim());
      } catch {
        actions = undefined;
      }
    }

    // rctrl diff — unified text; include when exit 0, else undefined.
    const diffResult = await exec([bin, 'diff', name], {
      cwd,
      env: mergeEnv(),
      timeoutMs: 30_000,
    });
    const diff =
      diffResult.exitCode === 0 && diffResult.output.trim().length > 0
        ? diffResult.output.trim()
        : undefined;

    // filesTouched: dedup(filesEdited ∪ filesWritten) from the manifest.
    const filesTouched = extractFilesTouched(actions);

    return { reason, finalMessage, actions, diff, filesTouched, telemetry: {} };
  }

  return { spawnWorker };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function randomHex(nibbles: number): string {
  // nibbles = number of hex chars (each byte = 2 hex chars)
  const bytes = Math.ceil(nibbles / 2);
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, nibbles);
}

function extractFilesTouched(actions: unknown): string[] {
  if (typeof actions !== 'object' || actions === null) return [];
  const a = actions as Record<string, unknown>;
  const edited = Array.isArray(a.filesEdited)
    ? (a.filesEdited as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const written = Array.isArray(a.filesWritten)
    ? (a.filesWritten as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const f of [...edited, ...written]) {
    if (!seen.has(f)) {
      seen.add(f);
      result.push(f);
    }
  }
  return result;
}
