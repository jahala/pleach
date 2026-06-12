import type { ExecFn } from '../loop/deps.ts';

// stdout and stderr are both captured and concatenated in arrival order.
// Because we drain both streams concurrently into the same string buffer,
// the interleaving reflects real-time ordering rather than stdout-first.
//
// On timeout: the process tree is killed (SIGKILL to the process group) and
// the function resolves — it does NOT throw — with the output gathered so far
// and a non-zero exitCode. This is required so the classify ladder can inspect
// the result rather than catching a surprise rejection. ledger: D1
//
// No shell is involved: argv is passed directly to Bun.spawn so that every
// element is treated as a literal argument — no word splitting, no glob
// expansion, no command substitution. ledger: SEC1

export const exec: ExecFn = async (argv, opts) => {
  const { cwd, timeoutMs, env } = opts;

  const mergedEnv = env ? { ...process.env, ...env } : process.env;

  // Totality: spawn itself can fail (nonexistent cwd or binary). The contract
  // is "the return type says so" — resolve with exit 127 (command-not-found
  // convention) instead of rejecting with an untyped Error.
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn(argv as string[], {
      cwd,
      env: mergedEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), exitCode: 127 };
  }

  let output = '';

  // Drain stdout and stderr concurrently so neither blocks the other.
  const drainStream = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
  };

  const drainDone = Promise.all([drainStream(proc.stdout), drainStream(proc.stderr)]);

  if (timeoutMs !== undefined) {
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      // Kill the process group to reap any children spawned by the command.
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // If killing the process group fails (e.g., no permission or already
        // exited), fall back to killing the process directly.
        try {
          proc.kill('SIGKILL');
        } catch {
          // Already gone — nothing to do.
        }
      }
    }, timeoutMs);

    await drainDone;
    const exitCode = await proc.exited;
    clearTimeout(timeoutHandle);

    return { output, exitCode: timedOut ? (exitCode !== 0 ? exitCode : 1) : exitCode };
  }

  await drainDone;
  const exitCode = await proc.exited;
  return { output, exitCode };
};
