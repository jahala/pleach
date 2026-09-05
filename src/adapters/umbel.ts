import { WorkerSeamError, WorkerSpawnError } from '../core/errors.ts';
import type { ExecFn, RunnerSeam, Worker, WorkerResult } from '../loop/deps.ts';
import { exec as defaultExec } from '../seams/exec.ts';

// ── createUmbelSeam ──────────────────────────────────────────────────────────
//
// Drives the umbel binary over ExecFn. Each verb is an arg-array invocation;
// ExecFn never rejects (spawn failure → exitCode 127).
//
// Per-worker sinceMtime threads send→wait correctly (race-free stop detection).

export interface UmbelSeamOpts {
  bin: string;
  // Process-level env for every umbel invocation (UMBEL_STATE etc.).
  env?: Record<string, string>;
  // Extra env vars passed as --env KEY=VAL to umbel spawn — reach the worker.
  // Use for FAKE_CLAUDE_* in tests; production typically leaves this empty.
  workerEnv?: Record<string, string>;
  // Tool allowlist for spawned workers. Claude-only (umbel rejects it for other
  // providers by design). A curated allowlist CANNOT cover MCP tools, so it is
  // not enough to keep an autonomous worker from blocking — see permissionMode.
  allowedTools?: string;
  // Permission/approval mode for workers (e.g. 'bypassPermissions'). The real fix
  // for unattended workers: a curated allowedTools list can't enumerate the MCP
  // tools the environment injects, so the worker blocks on the first prompt. The
  // conductor's safety is external (disposable worktree + cross-provider audit
  // + gates), so bypassing in-worker prompts is correct here. Rides claude (any
  // mode) AND codex ('bypassPermissions' → umbel maps it to codex's
  // --dangerously-bypass-approvals-and-sandbox so an unattended auditor doesn't
  // block on codex's approval prompt). Suppressed for other providers, which
  // umbel rejects. umbel is the enforcing guardrail, not the seam.
  permissionMode?: string;
}

// The concrete return type is structurally compatible with RunnerSeam; the
// inferred type exposes the extra __name field on workers for test access.
export function createUmbelSeam(exec: ExecFn, opts: UmbelSeamOpts) {
  const {
    bin,
    env: seamEnv = {},
    workerEnv: seamWorkerEnv = {},
    allowedTools,
    permissionMode,
  } = opts;

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

    // Unattended is the default posture (owner ruling, decker run 4): a fleet
    // worker must never be interactively prompted — the needs-a-human lane is
    // for refusals and human checks, not consent clicks. umbel maps the flag
    // to per-provider no-prompt equivalents and FAILS FAST at spawn for a
    // provider that cannot comply (its #57). An umbel too old to know the
    // flag refuses the spawn loudly — the substrate floor is documented.
    const argv: string[] = [bin, 'spawn', '--name', name, '--cwd', spec.cwd, '--unattended'];
    if (spec.provider !== undefined) argv.push('--provider', spec.provider);
    if (spec.model !== undefined) argv.push('--model', spec.model);
    const provider = spec.provider ?? 'claude';
    if (allowedTools !== undefined && provider === 'claude') {
      argv.push('--allowed-tools', allowedTools);
    }
    // permissionMode rides claude (any mode) AND codex ('bypassPermissions' →
    // codex's --dangerously-bypass-approvals-and-sandbox). umbel validates and
    // rejects per-provider; suppressing it elsewhere (gemini) avoids a spawn umbel
    // would reject.
    if (permissionMode !== undefined && (provider === 'claude' || provider === 'codex')) {
      argv.push('--permission-mode', permissionMode);
    }
    // Pass per-worker env vars as --env KEY=VAL flags (reaches the worker process).
    for (const [k, v] of Object.entries(seamWorkerEnv)) {
      argv.push('--env', `${k}=${v}`);
    }

    const result = await exec(argv, { cwd: spec.cwd, env: mergeEnv() });

    if (result.exitCode !== 0) {
      throw new WorkerSpawnError(`umbel spawn exited ${result.exitCode}: ${result.output.trim()}`);
    }

    // stdout: "spawned: <name>\n" — verify the name appears
    if (!result.output.includes(name)) {
      throw new WorkerSpawnError(
        `umbel spawn succeeded but name not found in output: ${result.output.trim()}`,
      );
    }

    // Post-spawn existence probe (decker finding). umbel ≥ its #55 fix
    // verifies the session itself before exiting 0 — but that guarantee is
    // point-in-time and version-dependent: an older umbel on PATH never
    // checks (`tmux new-session -d` exits 0 once the server ACCEPTS the
    // command — nothing lied, nobody checked), and a worker can die between
    // spawn's return and our first send. The probe covers both: fail here as
    // a spawn error, not hours later as a wait-timeout.
    const probe = await exec([bin, 'status', name], { cwd: spec.cwd, env: mergeEnv() });
    if (probe.exitCode !== 0) {
      throw new WorkerSpawnError(
        `umbel spawn reported success but session ${name} does not exist — ` +
          `is a tmux server running for this user? (${probe.output.trim()})`,
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

    async function wait(waitOpts?: {
      timeoutMs?: number;
      signal?: AbortSignal;
    }): Promise<WorkerResult> {
      const argv: string[] = [bin, 'wait', '--json'];

      if (sinceMtime !== undefined) {
        argv.push('--since', String(sinceMtime));
      }

      if (waitOpts?.timeoutMs !== undefined) {
        argv.push('--timeout', `${waitOpts.timeoutMs}ms`);
      }

      argv.push(name);

      // Give exec headroom beyond umbel's own timeout so ExecFn doesn't race.
      const execTimeout =
        waitOpts?.timeoutMs !== undefined ? waitOpts.timeoutMs + 10_000 : undefined;

      const result = await exec(argv, {
        cwd,
        env: mergeEnv(),
        timeoutMs: execTimeout,
        // Abort interrupts the WAIT only (D12) — teardown commands (kill,
        // dispose) must never ride the signal that triggered them.
        ...(waitOpts?.signal !== undefined ? { signal: waitOpts.signal } : {}),
      });

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
  // Assembles WorkerResult from the wait reason + subsidiary umbel verbs.
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

    // umbel read — last assistant message, untruncated (ledger C4).
    const readResult = await exec([bin, 'read', name], {
      cwd,
      env: mergeEnv(),
      timeoutMs: 30_000,
    });
    const finalMessage = readResult.exitCode === 0 ? readResult.output.trim() : '';

    // umbel actions --json — the raw ActionManifest (toolsUsed, files*, errors,
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

    // umbel diff — unified text; include when exit 0, else undefined.
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

// Public adapter factory for pleach.config.ts — wires the default audited exec.
export function umbelRunner(opts: UmbelSeamOpts): RunnerSeam {
  return createUmbelSeam(defaultExec, opts);
}
