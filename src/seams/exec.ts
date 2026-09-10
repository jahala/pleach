import { SPAWN_FAILED_EXIT } from '../core/classify.ts';
import type { ExecFn } from '../loop/deps.ts';

// stdout and stderr are both captured and concatenated in arrival order.
// Because we drain both streams concurrently into the same string buffer,
// the interleaving reflects real-time ordering rather than stdout-first.
//
// On timeout OR abort (D12 teardown): the process tree is killed (SIGKILL to
// the process group) and the function resolves — it does NOT throw — with the
// output gathered so far and a non-zero exitCode. This is required so the
// classify ladder can inspect the result rather than catching a surprise
// rejection. ledger: D1
//
// No shell is involved: argv is passed directly to Bun.spawn so that every
// element is treated as a literal argument — no word splitting, no glob
// expansion, no command substitution. ledger: SEC1

export const exec: ExecFn = async (argv, opts) => {
  const { cwd, timeoutMs, env, signal } = opts;

  const mergedEnv = env ? { ...process.env, ...env } : process.env;

  // Totality: spawn itself can fail (nonexistent cwd or binary). The contract
  // is "the return type says so" — resolve with exit 127 (command-not-found
  // convention) instead of rejecting with an untyped Error. The loop reads it
  // as the environment's fault, never the work's (ledger D19).
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn(argv as string[], {
      cwd,
      env: mergedEnv,
      stdout: 'pipe',
      stderr: 'pipe',
      // Its own process group, so the interrupt below can reap the whole tree
      // (ledger D16). A child that inherits OUR group is not a group leader, so
      // `kill(-pid)` names no group: the command dies, the `sleep` it forked
      // lives on holding the pipe, and the drain — hence the abort — waits out
      // the very work it is tearing down. It also makes teardown the seam's
      // alone: a terminal's Ctrl-C reaches pleach, which quarantines and
      // records, instead of also felling every gate command behind its back.
      detached: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { output: message, stdout: '', exitCode: SPAWN_FAILED_EXIT };
  }

  let output = '';
  let stdout = '';

  // Drain stdout and stderr concurrently so neither blocks the other. The
  // stdout drain keeps its own copy of what it read: `output` is the two
  // streams interleaved, `stdout` is the child's stdout alone.
  const drainStream = async (stream: ReadableStream<Uint8Array>, isStdout: boolean) => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    const keep = (text: string) => {
      output += text;
      if (isStdout) stdout += text;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      keep(decoder.decode(value, { stream: true }));
    }
    keep(decoder.decode()); // flush any buffered incomplete multi-byte sequence
  };

  const drainDone = Promise.all([drainStream(proc.stdout, true), drainStream(proc.stderr, false)]);

  // Kill the process group — the child leads its own (see spawn above), so this
  // reaps everything the command forked; fall back to the process itself (no
  // permission / already exited).
  const killTree = () => {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Already gone — nothing to do.
      }
    }
  };

  // Timeout and abort (D12) share one interrupt path and one contract:
  // resolve — never throw — with the output gathered so far and a non-zero
  // exitCode, so the classify ladder inspects a result instead of catching a
  // surprise rejection.
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    killTree();
  };

  if (signal?.aborted) interrupt();
  signal?.addEventListener('abort', interrupt, { once: true });
  const timeoutHandle = timeoutMs !== undefined ? setTimeout(interrupt, timeoutMs) : undefined;

  await drainDone;
  const exitCode = await proc.exited;
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  signal?.removeEventListener('abort', interrupt);

  return { output, stdout, exitCode: interrupted && exitCode === 0 ? 1 : exitCode };
};
