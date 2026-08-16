import { WorkerSeamError } from '../core/errors.ts';
import type { RunnerSeam, Worker, WorkerResult } from '../loop/deps.ts';

// directCliRunner — RunnerSeam over headless agent CLIs (`claude -p`,
// `codex exec`) as one-shot subprocesses. The lean profile: no umbel, no tmux —
// just the provider CLIs on PATH. Select it with `pleach run --runner
// direct-cli` or import it in a pleach.config.ts.
//
// !! THE ARGV TABLE TRACKS EXTERNAL CLIs AND DRIFTS !!
// The flags below are pinned by test/unit/direct-cli-runner.test.ts so drift
// breaks CI, not a run — but the installed CLI versions are the user's
// substrate responsibility (same as `git >= 2.38`). A rejected flag exits
// non-zero and surfaces as a 'dead' worker with the CLI's output in evidence —
// loud, never silent. To adapt for another provider, copy this file into your
// own config (the runner port is the whole integration surface).
//
// SCOPE — SINGLE-TURN {prompt} WORK ONLY. One send() → one wait() → one CLI
// invocation. Multi-turn {phases} work needs session resumption (`claude
// --continue` / `codex resume`) — unverified against installed CLIs, so a
// second send throws WorkerSeamError instead of silently starting a fresh
// session. Use umbel (or a custom runner) for phases.
//
// Provider      | argv
// --------------+--------------------------------------------------------------
// 'claude' (default) | ['claude', '-p', <prompt>, '--permission-mode', 'bypassPermissions']
//                    |   + ['--model', <model>] if model is set
// 'codex'            | ['codex', 'exec', <prompt>, '--dangerously-bypass-approvals-and-sandbox']
//                    |   + ['--model', <model>] if model is set
// any other          | throws WorkerSeamError naming the unsupported provider

// ── injected dependencies — the seam boundaries that make this unit-testable ──

export interface SpawnHandle {
  /** Resolves with the full stdout of the process. */
  stdout: Promise<string>;
  /** Resolves with the exit code of the process. */
  exited: Promise<number>;
  /** Terminate the process; stdout/exited must still settle afterwards. */
  kill(): void;
}

export interface DirectCliOpts {
  /** Spawn a subprocess. Defaults to a thin Bun.spawn wrapper. */
  spawn?: (argv: string[], cwd: string) => SpawnHandle;
  /**
   * List files changed in `cwd` since the last commit (the filesTouched hint).
   * Defaults to `git diff --name-only HEAD` plus untracked-unignored files.
   */
  changedFiles?: (cwd: string) => Promise<string[]>;
}

function buildArgv(provider: string | undefined, prompt: string, model: string | undefined) {
  const p = provider ?? 'claude';

  if (p === 'claude') {
    return [
      'claude',
      '-p',
      prompt,
      '--permission-mode',
      'bypassPermissions',
      ...(model ? ['--model', model] : []),
    ];
  }

  if (p === 'codex') {
    return [
      'codex',
      'exec',
      prompt,
      '--dangerously-bypass-approvals-and-sandbox',
      ...(model ? ['--model', model] : []),
    ];
  }

  throw new WorkerSeamError(
    `directCliRunner: unsupported provider '${p}'. Supported: 'claude', 'codex'. ` +
      `Copy src/adapters/direct-cli.ts into your config and add an argv branch for your provider.`,
  );
}

function defaultSpawn(argv: string[], cwd: string): SpawnHandle {
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  return {
    stdout: new Response(proc.stdout).text(),
    exited: proc.exited,
    kill: () => proc.kill(),
  };
}

async function defaultChangedFiles(cwd: string): Promise<string[]> {
  const diffProc = Bun.spawn(['git', '-C', cwd, 'diff', '--name-only', 'HEAD'], {
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const diffOut = await new Response(diffProc.stdout).text();
  await diffProc.exited;

  const untrackedProc = Bun.spawn(
    ['git', '-C', cwd, 'ls-files', '--others', '--exclude-standard'],
    {
      stdout: 'pipe',
      stderr: 'inherit',
    },
  );
  const untrackedOut = await new Response(untrackedProc.stdout).text();
  await untrackedProc.exited;

  return [...diffOut.split('\n'), ...untrackedOut.split('\n')].map((f) => f.trim()).filter(Boolean);
}

// ── directCliRunner — the exported factory ───────────────────────────────────

export function directCliRunner(opts: DirectCliOpts = {}): RunnerSeam {
  const spawn = opts.spawn ?? defaultSpawn;
  const getChangedFiles = opts.changedFiles ?? defaultChangedFiles;

  return {
    spawnWorker: async (spec): Promise<Worker> => {
      let pendingPrompt: string | undefined;
      let turnUsed = false;
      let inFlight: SpawnHandle | null = null;

      const worker: Worker = {
        send: async (text: string): Promise<void> => {
          if (turnUsed) {
            throw new WorkerSeamError(
              'directCliRunner is single-turn: a second send() needs session resumption ' +
                '({phases} work) — use umbel or a custom runner',
            );
          }
          pendingPrompt = text;
        },

        wait: async (waitOpts?: { timeoutMs?: number }): Promise<WorkerResult> => {
          const prompt = pendingPrompt ?? '';
          turnUsed = true;
          const argv = buildArgv(spec.provider, prompt, spec.model);

          const handle = spawn(argv, spec.cwd);
          inFlight = handle;

          // ledger D1: a hung CLI must not consume a slot forever — kill on
          // timeout and report 'timeout' so the loop's retry ladder applies.
          let timedOut = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          if (waitOpts?.timeoutMs !== undefined) {
            timer = setTimeout(() => {
              timedOut = true;
              handle.kill();
            }, waitOpts.timeoutMs);
          }

          const [finalMessage, exitCode] = await Promise.all([handle.stdout, handle.exited]);
          if (timer !== undefined) clearTimeout(timer);
          inFlight = null;

          const filesTouched = await getChangedFiles(spec.cwd);
          const reason: WorkerResult['reason'] = timedOut
            ? 'timeout'
            : exitCode === 0
              ? 'stop'
              : 'dead';

          return {
            finalMessage,
            filesTouched,
            reason,
            exitCode,
            telemetry: {},
          };
        },

        kill: async (): Promise<void> => {
          // Abort an in-flight invocation; a settled one has nothing to kill.
          inFlight?.kill();
        },
      };

      return worker;
    },
  };
}
