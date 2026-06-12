import { toArgv } from '../core/argv.ts';
import { GateFailedError } from '../core/errors.ts';
import type { Node } from '../core/plan.ts';
import type { ExecFn, Worker, WorkerResult } from './deps.ts';

// runWork drives one attempt of a node's Work through its worker + exec gates.
// It is given everything; it never reaches for a seam module. The caller
// (runNode) owns isolation, classification, retries and the worker lifecycle —
// runWork only sends prompts, waits, and runs the exit-code gates that belong
// to the Work shape. A non-stop wait (dead/timeout/input/idle/aborted) STOPS
// the attempt immediately and is returned verbatim: blocked preempts every
// gate (binding prose), and the run-node ladder decides what the reason means.

export interface RunWorkOpts {
  timeoutMs: number;
  // Evidence section appended to the worker prompt on a retry attempt (A3).
  // Absent on the first attempt; present and non-empty on every retry.
  evidence?: string;
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
  worker: Worker,
  exec: ExecFn,
  cwd: string,
  opts: RunWorkOpts,
): Promise<WorkerResult> {
  const { work } = node;

  if ('command' in work) {
    const { output, exitCode } = await exec(toArgv(work.command), {
      cwd,
      timeoutMs: opts.timeoutMs,
    });
    if (exitCode !== 0) throw new GateFailedError('command', output);
    return {
      finalMessage: output,
      filesTouched: [],
      exitCode,
      reason: 'stop',
      telemetry: {},
    };
  }

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
      await worker.send(text);
      last = await worker.wait({ timeoutMs: opts.timeoutMs });
      if (last.reason !== 'stop') return last;

      if (phase.phase === 'red') {
        const { output, exitCode } = await exec(toArgv(work.test), {
          cwd,
          timeoutMs: opts.timeoutMs,
        });
        // RED must FAIL: a test that already passes means no failing test was
        // written (or a harness error) — the TDD guarantee is void.
        if (exitCode === 0) throw new GateFailedError('red', output);
      } else if (phase.phase === 'green') {
        const { output, exitCode } = await exec(toArgv(work.test), {
          cwd,
          timeoutMs: opts.timeoutMs,
        });
        if (exitCode !== 0) throw new GateFailedError('green', output);
      }
    }
    // phases is non-empty by construction (zod array); last is set.
    return last as WorkerResult;
  }

  // {prompt}: single send/wait.
  await worker.send(promptFor(node, opts.evidence));
  return worker.wait({ timeoutMs: opts.timeoutMs });
}
