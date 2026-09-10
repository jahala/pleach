import { shellOperatorTokens, toArgv } from '../core/argv.ts';
import { GateFailedError, PlanInvalidError } from '../core/errors.ts';
import type { Node } from '../core/plan.ts';
import type { ExecFn, ExecResult, Worker, WorkerResult } from './deps.ts';

// Exec a plan-authored command string with the no-shell guard: a bare shell
// operator would be passed as a literal argument and do silently-wrong things
// (the 2026-08-17 canary catch). Guard hits report exitCode -1 with the
// escape hatch named, flowing through each gate's existing failure path.
export async function guardedExec(
  exec: ExecFn,
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<ExecResult> {
  const refusal = shellGuardRefusal(command);
  if (refusal !== null) {
    // No child ran, so there is no stdout — pleach's own finding, on `output`.
    return { output: refusal, stdout: '', exitCode: -1 };
  }
  return exec(toArgv(command), opts);
}

// The guard as a question, askable without running anything: why `command`
// cannot be exec'd, or null when it can. A caller that knows a command is
// unrunnable before it provisions anything (a land gate, D18) refuses there
// instead of paying for a worktree first.
export function shellGuardRefusal(command: string): string | null {
  const ops = shellOperatorTokens(toArgv(command));
  if (ops.length === 0) return null;
  return (
    `command contains bare shell operator(s): ${ops.join(' ')} — pleach execs ` +
    `without a shell (arg-array; contract exec semantics). For shell features, ` +
    `wrap the command: bash -lc '<command>'`
  );
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
  // Teardown signal (D12): interrupts the WAIT — the run's long pole — and,
  // for a {command} node, the command that stands in for one (D16). Gates run
  // to completion, bounded by their own timeouts.
  signal?: AbortSignal;
  // The conductor's idle timeout (D16): every wait this attempt makes ends
  // when the worker has been quiet that long, instead of riding timeoutMs.
  idleMs?: number;
  // The red-phase seal (D13): called with the red phase's worker result and the
  // red gate's exit code the moment the RED gate passes and before the next
  // phase's prompt is sent, so the failing-test state is history. run-node
  // supplies it — it owns the isolate seam and the journal; runWork only decides
  // the moment. It also REFUSES an empty red phase, throwing GateFailedError
  // ('red', …) like any gate: what the phase actually touched is the isolate
  // seam's to see, which is why the exit code travels there rather than the
  // file set travelling here.
  sealRed?: (result: WorkerResult, exitCode: number, phaseIndex: number) => Promise<void>;
  // The phase index this attempt's tree ALREADY has sealed (D13), or undefined
  // for a tree that has sealed nothing. run-node tracks it per tree, so a
  // re-isolated tree (dead+resume) arrives undefined. The ladder re-enters
  // after that phase instead of remaking a seal the tree can no longer
  // honestly produce.
  redSealedAt?: number;
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
      // A {command} node spawns no worker, so this exec IS its wait — the run's
      // long pole, and the one thing the teardown signal must reach (D16).
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    // The run's own signal fired: the exec seam SIGKILLed the command tree, so
    // the non-zero exit below reports our teardown, not the command. This is
    // where that is knowable — the same answer the umbel adapter gives for an
    // interrupted wait — so run-node hands the live tree back with status
    // 'aborted' (receipt written, tree quarantined as it stands) instead of
    // reading a halt as a failed gate and retrying it (ledger D16).
    if (exitCode !== 0 && opts.signal?.aborted === true) {
      return {
        finalMessage: output,
        filesTouched: [],
        exitCode,
        reason: 'aborted',
        telemetry: {},
      };
    }
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
    // Where this attempt enters the ladder. A tree whose red is already sealed
    // re-enters AFTER the phase that sealed (D13): the failing-test state is
    // history, and a second red taken from a tree that now holds impl work
    // would seal a lie. Everything before that phase goes with it — its output
    // is inside the red commit already. The index, not merely a flag: a phase
    // list may carry more than one red, and a later one that never ran must
    // still run.
    const start = opts.redSealedAt !== undefined ? opts.redSealedAt + 1 : 0;
    // Nothing left to run: the list is empty, or it ends on the red phase this
    // tree already sealed. Either way a retry has no prompt to send that would
    // not remake the seal — a typed plan error, never a silent empty attempt.
    if (start >= work.phases.length) {
      throw new PlanInvalidError([
        `node '${node.id}': no phase left to run (entering at ${start} of ${work.phases.length} phases)`,
      ]);
    }
    let last: WorkerResult | null = null;
    for (let i = start; i < work.phases.length; i += 1) {
      const phase = work.phases[i] as (typeof work.phases)[number];
      // On a retry, the evidence rides the first phase prompt this attempt
      // actually sends — the impl phase when the red is sealed — so the worker
      // sees why the previous attempt failed before re-entering the cycle (A3).
      const text =
        i === start && opts.evidence !== undefined && opts.evidence.length > 0
          ? withEvidence(phase.prompt, opts.evidence)
          : phase.prompt;
      await w.send(text);
      last = await w.wait({ timeoutMs: opts.timeoutMs, signal: opts.signal, idleMs: opts.idleMs });
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
        // prove the test ever failed. A red phase that wrote nothing fails the
        // gate here instead of sealing.
        if (opts.sealRed) await opts.sealRed(last, exitCode, i);
      } else if (phase.phase === 'green') {
        const { output, exitCode } = await guardedExec(exec, work.test, {
          cwd,
          timeoutMs: opts.timeoutMs,
        });
        if (exitCode !== 0) throw new GateFailedError('green', output, exitCode);
      }
    }
    // The guard above ran at least one phase, so last is set.
    return last as WorkerResult;
  }

  // {prompt}: single send/wait.
  await w.send(promptFor(node, opts.evidence));
  return w.wait({ timeoutMs: opts.timeoutMs, signal: opts.signal, idleMs: opts.idleMs });
}
