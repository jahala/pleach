import { shellOperatorTokens, toArgv } from '../core/argv.ts';
import { GateFailedError } from '../core/errors.ts';
import type { Node } from '../core/plan.ts';
import type { ExecFn, Worker, WorkerResult } from './deps.ts';

// Exec a plan-authored command string with the no-shell guard: a bare shell
// operator would be passed as a literal argument and do silently-wrong things
// (the 2026-08-17 canary catch). Guard hits report exitCode -1 with the
// escape hatch named, flowing through each gate's existing failure path.
export async function guardedExec(
  exec: ExecFn,
  command: string,
  opts: { cwd: string; timeoutMs: number },
): Promise<{ output: string; exitCode: number }> {
  const tokens = toArgv(command);
  const ops = shellOperatorTokens(tokens);
  if (ops.length > 0) {
    return {
      output:
        `command contains bare shell operator(s): ${ops.join(' ')} — pleach execs ` +
        `without a shell (arg-array; contract exec semantics). For shell features, ` +
        `wrap the command: bash -lc '<command>'`,
      exitCode: -1,
    };
  }
  return exec(tokens, opts);
}

// runWork drives one attempt of a node's Work through its worker + exec gates.
// It is given everything; it never reaches for a seam module. The caller
// (runNode) owns isolation, classification, retries and the worker lifecycle —
// runWork only sends prompts, waits, and runs the exit-code gates that belong
// to the Work shape; {command} work runs entirely through exec and is given a
// null worker (run-node spawns none for it). A non-stop wait
// (dead/timeout/input/idle/aborted) STOPS
// the attempt immediately and is returned verbatim: blocked preempts every
// gate (binding prose), and the run-node ladder decides what the reason means.

export interface RunWorkOpts {
  timeoutMs: number;
  // Evidence section appended to the worker prompt on a retry attempt (A3).
  // Absent on the first attempt; present and non-empty on every retry.
  evidence?: string;
  // Teardown signal (D12): interrupts the WAIT — the run's long pole. Work
  // commands and gates run to completion, bounded by their own timeouts.
  signal?: AbortSignal;
  // The red-phase seal (D13): called with the red phase's worker result the
  // moment the RED gate passes and before the next phase's prompt is sent, so
  // the failing-test state is history. run-node supplies it — it owns the
  // isolate seam and the journal; runWork only decides the moment.
  sealRed?: (result: WorkerResult) => Promise<void>;
}

// The base worker prompt for a node, plus an optional clearly-delimited
// evidence section for retry attempts. {test,phases} and {command} nodes have
// no single base prompt; their per-phase prompts are sent inside runWork, so
// promptFor returns just the evidence framing for those shapes (used only when
// run-node re-prompts — which only happens for {prompt} and {test,phases}).
function withEvidence(base: string, evidence: string): string {
  return `${base}\n\n--- previous attempt failed; fix this and continue ---\n${evidence}`;
}

export function promptFor(node: Node, evidence?: string): string {
  const base = 'prompt' in node.work ? node.work.prompt : '';
  if (evidence === undefined || evidence.length === 0) return base;
  return withEvidence(base, evidence);
}

export async function runWork(
  node: Node,
  worker: Worker | null,
  exec: ExecFn,
  cwd: string,
  opts: RunWorkOpts,
): Promise<WorkerResult> {
  const { work } = node;

  if ('command' in work) {
    const { output, exitCode } = await guardedExec(exec, work.command, {
      cwd,
      timeoutMs: opts.timeoutMs,
    });
    if (exitCode !== 0) throw new GateFailedError('command', output, exitCode);
    return {
      finalMessage: output,
      filesTouched: [],
      exitCode,
      reason: 'stop',
      telemetry: {},
    };
  }

  // Past the command shape the work is {prompt} or {phases}; run-node spawns a
  // worker for exactly those, so one is always present here.
  const w = worker as Worker;

  if ('phases' in work) {
    let last: WorkerResult | null = null;
    for (let i = 0; i < work.phases.length; i += 1) {
      const phase = work.phases[i] as (typeof work.phases)[number];
      // On a retry, the evidence rides the first phase prompt so the worker
      // sees why the previous attempt failed before re-entering the cycle (A3).
      const text =
        i === 0 && opts.evidence !== undefined && opts.evidence.length > 0
          ? withEvidence(phase.prompt, opts.evidence)
          : phase.prompt;
      await w.send(text);
      last = await w.wait({ timeoutMs: opts.timeoutMs, signal: opts.signal });
      if (last.reason !== 'stop') return last;

      if (phase.phase === 'red') {
        const { output, exitCode } = await guardedExec(exec, work.test, {
          cwd,
          timeoutMs: opts.timeoutMs,
        });
        // RED must FAIL: a test that already passes means no failing test was
        // written (or a harness error) — the TDD guarantee is void.
        if (exitCode === 0) throw new GateFailedError('red', output, exitCode);
        // The red state is sealed as its own commit before the next prompt goes
        // out (D13) — after that the tree carries impl work and nothing can
        // prove the test ever failed.
        if (opts.sealRed) await opts.sealRed(last);
      } else if (phase.phase === 'green') {
        const { output, exitCode } = await guardedExec(exec, work.test, {
          cwd,
          timeoutMs: opts.timeoutMs,
        });
        if (exitCode !== 0) throw new GateFailedError('green', output, exitCode);
      }
    }
    // phases is non-empty by construction (zod array); last is set.
    return last as WorkerResult;
  }

  // {prompt}: single send/wait.
  await w.send(promptFor(node, opts.evidence));
  return w.wait({ timeoutMs: opts.timeoutMs, signal: opts.signal });
}
