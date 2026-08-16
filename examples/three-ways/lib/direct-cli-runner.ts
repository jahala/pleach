/**
 * direct-cli-runner — template RunnerSeam for headless agent CLIs.
 *
 * TEMPLATE, NOT BUNDLED. This file is a copy-and-adapt starting point; it is
 * NOT shipped in src/adapters/ because CLI flags drift with each provider
 * release and must be verified against the installed CLI version before use.
 * A dev copies this file, confirms the argv table below, then imports it from
 * their own plan config.
 *
 * SCOPE — SINGLE-TURN {prompt} WORK ONLY. Each spawnWorker call handles one
 * send() → wait() cycle: one prompt in, one CLI invocation, one WorkerResult
 * out. Multi-turn {phases} work (multiple send/wait pairs on the same Worker)
 * would require CLI session resumption — e.g. `claude --continue` or
 * `codex resume` — which is an extension point left for the adopter.
 *
 * IMPORTERS: ../02-direct-cli and ../03-library import this module.
 */

import type { RunnerSeam, Worker, WorkerResult } from '../../../src/loop/deps.ts';

// ---------------------------------------------------------------------------
// Injected dependencies — these are the seam boundaries that make the runner
// unit-testable without running a real CLI or a real git process.
// ---------------------------------------------------------------------------

export interface SpawnResult {
  /** Resolves with the full stdout of the process. */
  stdout: Promise<string>;
  /** Resolves with the exit code of the process. */
  exited: Promise<number>;
}

export interface DirectCliOpts {
  /**
   * Spawn a subprocess. Defaults to a thin Bun.spawn wrapper.
   * Receives the full argv array and the worktree cwd.
   */
  spawn?: (argv: string[], cwd: string) => SpawnResult;

  /**
   * Return the list of files changed in `cwd` since the last commit.
   * Defaults to `git -C <cwd> diff --name-only HEAD` plus untracked files.
   */
  changedFiles?: (cwd: string) => Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Per-provider argv table.
//
// !! THESE FLAGS TRACK EXTERNAL CLIs AND DRIFT !!
// Verify every flag against your installed CLI version before use.
// This is exactly why this runner is a template rather than a bundled adapter.
//
// Provider      | argv prefix
// --------------+--------------------------------------------------------------
// 'claude' (default) | ['claude', '-p', <prompt>, '--permission-mode', 'bypassPermissions']
//                    |   + ['--model', <model>] if model is set
// 'codex'            | ['codex', 'exec', <prompt>, '--dangerously-bypass-approvals-and-sandbox']
//                    |   + ['--model', <model>] if model is set
// any other          | throws Error naming the unsupported provider
// ---------------------------------------------------------------------------

function buildArgv(
  provider: string | undefined,
  prompt: string,
  model: string | undefined,
): string[] {
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

  throw new Error(
    `directCliRunner: unsupported provider '${p}'. Supported: 'claude', 'codex'. ` +
      `Add a branch to buildArgv() in direct-cli-runner.ts for your provider.`,
  );
}

// ---------------------------------------------------------------------------
// Default spawn — thin Bun.spawn wrapper. Not used in tests (injected out).
// ---------------------------------------------------------------------------

function defaultSpawn(argv: string[], cwd: string): SpawnResult {
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const stdout = new Response(proc.stdout).text();
  const exited = proc.exited;

  return { stdout, exited };
}

// ---------------------------------------------------------------------------
// Default changedFiles — git diff + untracked. Not used in tests (injected).
// ---------------------------------------------------------------------------

async function defaultChangedFiles(cwd: string): Promise<string[]> {
  const diffProc = Bun.spawn(['git', '-C', cwd, 'diff', '--name-only', 'HEAD'], {
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const diffOut = await new Response(diffProc.stdout).text();
  await diffProc.exited;

  const untrackedProc = Bun.spawn(
    ['git', '-C', cwd, 'ls-files', '--others', '--exclude-standard'],
    { stdout: 'pipe', stderr: 'inherit' },
  );
  const untrackedOut = await new Response(untrackedProc.stdout).text();
  await untrackedProc.exited;

  return [...diffOut.split('\n'), ...untrackedOut.split('\n')].map((f) => f.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// directCliRunner — the exported factory
// ---------------------------------------------------------------------------

export function directCliRunner(opts: DirectCliOpts = {}): RunnerSeam {
  const spawn = opts.spawn ?? defaultSpawn;
  const getChangedFiles = opts.changedFiles ?? defaultChangedFiles;

  return {
    spawnWorker: async (spec): Promise<Worker> => {
      // Capture the prompt from send() — single-turn: one send before one wait.
      let pendingPrompt: string | undefined;

      const worker: Worker = {
        send: async (text: string): Promise<void> => {
          pendingPrompt = text;
        },

        wait: async (): Promise<WorkerResult> => {
          const prompt = pendingPrompt ?? '';
          const argv = buildArgv(spec.provider, prompt, spec.model);

          const { stdout: stdoutP, exited: exitedP } = spawn(argv, spec.cwd);
          const [finalMessage, exitCode] = await Promise.all([stdoutP, exitedP]);

          const filesTouched = await getChangedFiles(spec.cwd);

          const reason: WorkerResult['reason'] = exitCode === 0 ? 'stop' : 'dead';

          return {
            finalMessage,
            filesTouched,
            reason,
            exitCode,
            telemetry: {},
          };
        },

        // No-op: a one-shot CLI invocation has no persistent process to abort.
        // Extension point: wire an AbortController to the Bun.spawn call above
        // if the adopter needs cancellation (e.g. for a timeout watchdog).
        kill: async (): Promise<void> => {
          // intentional no-op for one-shot CLI
        },
      };

      return worker;
    },
  };
}
