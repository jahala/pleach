import { toArgv } from '../core/argv.ts';
import { buildAuditPrompt, extractAuditJson } from '../core/audit-egress.ts';
import { classify } from '../core/classify.ts';
import {
  AuditParseError,
  GateFailedError,
  IsolateCatastrophicError,
  PlanInvalidError,
} from '../core/errors.ts';
import { type AuditResult, AuditResultSchema, type Node, type Verdict } from '../core/plan.ts';
import { DEFAULT_WORKER_PROVIDER } from '../core/validate.ts';
import type { ConductorDeps, Isolation, WorkerResult } from './deps.ts';
import { runWork } from './run-work.ts';

// ── run-node: the per-node ladder ────────────────────────────────────────────
//
// One node, start to verdict. Composes injected seams only — never reaches a
// seam module. The ladder per attempt: isolate → setup → work → marker gate →
// scoped stage → smoke → audit → done. Non-stop worker reasons and gate
// failures are routed through core/classify; retryable attempts reuse the tree
// and re-prompt with the failure's evidence (A3); dead+resume re-isolates.
//
// run-node does NOT commit or emit — it returns the live isolation and the
// staged file set so run-plan can commit-before-emit then dispose (B2).

export interface RunNodeOpts {
  defaultTimeoutMs: number;
}

export interface RunNodeResult {
  verdict: Verdict;
  // The live isolation for a done node — run-plan commits then disposes. Absent
  // for terminal verdicts that already disposed (or never isolated).
  iso?: Isolation;
  stagedFiles?: string[];
}

const REAUDIT_BUDGET = 2;

export async function runNode(
  node: Node,
  baseRefs: readonly string[],
  deps: ConductorDeps,
  opts: RunNodeOpts,
): Promise<RunNodeResult> {
  // disposeQuiet: journal+swallow IsolateCatastrophicError so a dispose failure
  // on a non-done verdict never overwrites the real verdict (blocked/dead/timeout).
  // Defined as a closure to capture deps.journal + node.id without threading params
  // to every call site.
  async function disposeQuiet(iso: Isolation): Promise<void> {
    try {
      await iso.dispose();
    } catch (err) {
      await deps.journal.append({
        event: 'dispose-failed',
        node: node.id,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Resolved-provider diversity preflight (binding prose) — before any spawn.
  const buildProvider = node.worker.provider ?? DEFAULT_WORKER_PROVIDER;
  if (node.accept.audit && node.accept.audit.provider === buildProvider) {
    throw new PlanInvalidError([
      `node '${node.id}': resolved audit provider '${node.accept.audit.provider}' must differ from build provider '${buildProvider}'`,
    ]);
  }

  const timeoutMs = node.policy.timeoutMs ?? opts.defaultTimeoutMs;
  const maxAttempts = node.policy.maxAttempts;

  // Tree lifecycle across attempts: retryable reuses `iso`; dead+resume
  // disposes and re-isolates. A terminal/done verdict hands `iso` to the caller
  // (done) or disposes it here (failed/dead/blocked).
  let iso: Isolation | null = null;
  // Evidence threaded into the next attempt's re-prompt (A3). undefined on the
  // first attempt.
  let evidence: string | undefined;
  let attempts = 0;

  try {
    for (;;) {
      attempts += 1;

      // ── isolate (or reuse the tree for a retryable retry) ───────────────────
      if (iso === null) {
        try {
          iso = await deps.isolate.isolate(node, baseRefs);
        } catch (err) {
          if (err instanceof IsolateCatastrophicError) {
            return {
              verdict: failedVerdict(node, attempts, {
                gate: { ran: `isolate ${baseRefs.join(',')}`, exitCode: -1 },
              }),
            };
          }
          throw err;
        }
      }
      const cwd = iso.cwd;

      // On the very first attempt, surface merge-conflict files in the prompt.
      const firstPromptExtra =
        attempts === 1 && iso.conflictFiles.length > 0
          ? `Resolve merge conflicts in: ${iso.conflictFiles.join(', ')}`
          : undefined;
      const promptEvidence = mergeEvidence(evidence, firstPromptExtra);

      // ── setup ───────────────────────────────────────────────────────────────
      if (node.setup) {
        const { output, exitCode } = await deps.exec(toArgv(node.setup), { cwd, timeoutMs });
        if (exitCode !== 0) {
          const settle = settleRetryable(node, attempts, maxAttempts, {
            gate: { ran: node.setup, exitCode },
          });
          if (settle) {
            await disposeQuiet(iso);
            return settle;
          }
          evidence = gateEvidence('setup', exitCode, output);
          continue; // retry — SAME tree (setup idempotent by contract)
        }
      }

      // ── work ────────────────────────────────────────────────────────────────
      // Command work execs directly (run-work) and never uses a worker; only a
      // {prompt}/{phases} node spawns a build worker — so a command-only plan
      // needs no runner at all.
      const worker =
        'command' in node.work
          ? null
          : await deps.runner.spawnWorker({
              provider: node.worker.provider,
              model: node.worker.model,
              cwd,
            });
      let result: WorkerResult;
      try {
        result = await runWork(node, worker, deps.exec, cwd, {
          timeoutMs,
          evidence: promptEvidence,
        });
      } catch (err) {
        await worker?.kill();
        if (err instanceof GateFailedError) {
          const decision = handleGate(node, attempts, maxAttempts, err);
          if (decision.settle) {
            await disposeQuiet(iso);
            return decision.settle;
          }
          evidence = decision.evidence;
          continue; // retryable — SAME tree
        }
        throw err;
      }
      await worker?.kill();

      // ── non-stop reasons ──────────────────────────────────────────────────
      if (result.reason !== 'stop') {
        const klass = classify({ kind: 'worker', reason: result.reason ?? 'aborted' });
        if (klass === 'blocked') {
          await disposeQuiet(iso);
          return {
            verdict: {
              ...baseVerdict(node, attempts),
              status: 'blocked',
              evidence: {
                ...baseVerdict(node, attempts).evidence,
                blockedReason: result.message,
              },
              telemetry: result.telemetry,
            },
          };
        }
        if (klass === 'dead') {
          if (node.policy.onDead === 'resume' && attempts < maxAttempts) {
            await disposeQuiet(iso);
            iso = null; // force re-isolate (fresh tree)
            evidence = undefined;
            continue;
          }
          await disposeQuiet(iso);
          return { verdict: { ...baseVerdict(node, attempts), status: 'dead' } };
        }
        // timeout → retryable (reuse tree); anything else terminal.
        if (klass === 'retryable' && attempts < maxAttempts) {
          evidence = `previous attempt ended: ${result.reason}`;
          continue;
        }
        await disposeQuiet(iso);
        return {
          verdict: failedVerdict(node, attempts, {
            gate: { ran: `wait:${result.reason}`, exitCode: -1 },
          }),
        };
      }

      // ── marker gate (ledger C1) ─────────────────────────────────────────────
      const markers = await deps.isolate.scanMarkers(cwd);
      if (markers.length > 0) {
        const settle = settleRetryable(node, attempts, maxAttempts, {
          gate: { ran: 'marker', exitCode: -1 },
        });
        if (settle) {
          await disposeQuiet(iso);
          return settle;
        }
        evidence = `Conflict markers remain in:\n${markers.join('\n')}\nResolve the conflict markers.`;
        continue;
      }

      // ── scoped staging (ledger C2 — nothing re-stages after this) ────────────
      const changed = await deps.isolate.changedFiles(cwd);
      const stagedFiles = dedup([...result.filesTouched, ...changed]);
      await deps.isolate.stage(cwd, stagedFiles);

      // ── smoke ────────────────────────────────────────────────────────────────
      if (node.accept.smoke) {
        const { output, exitCode } = await deps.exec(toArgv(node.accept.smoke), { cwd, timeoutMs });
        if (exitCode !== 0) {
          const settle = settleRetryable(node, attempts, maxAttempts, {
            gate: { ran: node.accept.smoke, exitCode },
          });
          if (settle) {
            await disposeQuiet(iso);
            return settle;
          }
          evidence = gateEvidence('smoke', exitCode, output);
          continue;
        }
      }

      // ── audit ────────────────────────────────────────────────────────────────
      let output: AuditResult | undefined;
      if (node.accept.audit) {
        const auditOutcome = await runAudit(node, cwd, deps, timeoutMs);
        if (auditOutcome.kind === 'parse-exhausted') {
          await disposeQuiet(iso);
          return {
            verdict: failedVerdict(node, attempts, {
              // node.accept.audit is defined inside this block.
              gate: { ran: `${node.accept.audit.command} (egress unparseable)`, exitCode: -1 },
            }),
          };
        }
        if (auditOutcome.kind === 'worker-fault') {
          // The auditor died / timed out / blocked — it never returned a verdict.
          // Distinct from a fail verdict; record the reason for the journal.
          await disposeQuiet(iso);
          return {
            verdict: failedVerdict(node, attempts, {
              gate: {
                ran: `${node.accept.audit.command} (auditor ${auditOutcome.reason})`,
                exitCode: -1,
              },
            }),
          };
        }
        if (auditOutcome.kind === 'fail') {
          const settle = settleRetryable(node, attempts, maxAttempts, {});
          if (settle) {
            await disposeQuiet(iso);
            return settle;
          }
          evidence = auditOutcome.evidence;
          continue; // audit-fail → re-prompt a FRESH build worker, SAME tree
        }
        output = auditOutcome.result;
      }

      // ── all gates passed → done ──────────────────────────────────────────────
      const verdict: Verdict = {
        node: node.id,
        status: 'done',
        output,
        evidence: {
          diffRef: undefined,
          filesTouched: stagedFiles,
          blockedReason: undefined,
        },
        telemetry: result.telemetry,
        attempts,
      };
      const liveIso = iso;
      iso = null; // hand ownership to the caller — do NOT dispose here.
      return { verdict, iso: liveIso, stagedFiles };
    }
  } finally {
    // Safety net: any tree still held by a thrown/early path is disposed.
    if (iso !== null) await disposeQuiet(iso);
  }
}

// ── audit ──────────────────────────────────────────────────────────────────

type AuditOutcome =
  | { kind: 'pass'; result: AuditResult }
  | { kind: 'fail'; evidence: string }
  | { kind: 'worker-fault'; reason: string; message?: string }
  | { kind: 'parse-exhausted' };

async function runAudit(
  node: Node,
  cwd: string,
  deps: ConductorDeps,
  timeoutMs: number,
): Promise<AuditOutcome> {
  // node.accept.audit is defined by the caller's guard.
  const audit = node.accept.audit as NonNullable<Node['accept']['audit']>;

  for (let reaudit = 0; reaudit < REAUDIT_BUDGET; reaudit += 1) {
    const worker = await deps.runner.spawnWorker({
      provider: audit.provider,
      model: audit.model,
      cwd,
    });
    let res: WorkerResult;
    try {
      await worker.send(buildAuditPrompt(audit.command));
      res = await worker.wait({ timeoutMs });
    } finally {
      await worker.kill();
    }

    // A non-stop auditor produced no verdict to read — it died, timed out, or
    // is held at a prompt. Feeding '' to the JSON parser would mis-label this
    // as bad egress; surface it honestly so the journal records WHY.
    if (res.reason !== 'stop') {
      return { kind: 'worker-fault', reason: res.reason ?? 'aborted', message: res.message };
    }

    let parsed: AuditResult;
    try {
      const raw = extractAuditJson(res.finalMessage);
      parsed = AuditResultSchema.parse(raw);
    } catch (err) {
      // Zod failure or AuditParseError → reaudit (bad egress), bounded.
      if (classify({ kind: 'error', error: asError(err) }) === 'reaudit') continue;
      // A non-reaudit error from parsing is unexpected; rethrow honestly.
      throw err;
    }

    const failing = parsed.verdicts.filter((v) => v.verdict === 'fail');
    if (failing.length > 0) {
      return { kind: 'fail', evidence: auditFailEvidence(failing) };
    }
    return { kind: 'pass', result: parsed };
  }
  return { kind: 'parse-exhausted' };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function asError(err: unknown): Error {
  return err instanceof Error ? err : new AuditParseError(String(err));
}

function handleGate(
  node: Node,
  attempts: number,
  maxAttempts: number,
  err: GateFailedError,
): { settle?: RunNodeResult; evidence?: string } {
  const settle = settleRetryable(node, attempts, maxAttempts, {
    gate: { ran: gateRanLabel(node, err), exitCode: err.exitCode },
  });
  if (settle) return { settle };
  return { evidence: gateEvidence(err.gate, err.exitCode, err.evidence) };
}

// The label recorded in evidence.gate.ran. For command/red/green/setup the
// concrete command string is most useful; fall back to the gate kind.
function gateRanLabel(node: Node, err: GateFailedError): string {
  switch (err.gate) {
    case 'command':
      return 'command' in node.work ? node.work.command : 'command';
    case 'red':
    case 'green':
      return 'test' in node.work ? node.work.test : err.gate;
    case 'smoke':
      return node.accept.smoke ?? 'smoke';
    case 'setup':
      return node.setup ?? 'setup';
    default:
      return err.gate;
  }
}

// Settle a retryable failure into a failed Verdict iff attempts are exhausted;
// otherwise return undefined (caller continues the loop).
function settleRetryable(
  node: Node,
  attempts: number,
  maxAttempts: number,
  extra: { gate?: { ran: string; exitCode: number } },
): RunNodeResult | undefined {
  if (attempts < maxAttempts) return undefined;
  return { verdict: failedVerdict(node, attempts, extra) };
}

const EVIDENCE_TAIL = 2000;

function gateEvidence(gate: string, exitCode: number, output: string): string {
  const tail = output.length > EVIDENCE_TAIL ? output.slice(-EVIDENCE_TAIL) : output;
  return `Gate '${gate}' failed (exit ${exitCode}). Output tail:\n${tail}`;
}

function auditFailEvidence(failing: AuditResult['verdicts']): string {
  const lines = failing.map(
    (v) =>
      `- check '${v.check}' FAILED: ${v.reasons.length > 0 ? v.reasons.join('; ') : '(no reasons given)'}`,
  );
  return `The cross-provider audit returned failing verdicts. Fix these:\n${lines.join('\n')}`;
}

function mergeEvidence(a: string | undefined, b: string | undefined): string | undefined {
  if (a && b) return `${a}\n\n${b}`;
  return a ?? b;
}

function baseVerdict(node: Node, attempts: number): Verdict {
  return {
    node: node.id,
    status: 'failed',
    output: undefined,
    evidence: { filesTouched: [] },
    telemetry: {},
    attempts,
  };
}

function failedVerdict(
  node: Node,
  attempts: number,
  extra: { gate?: { ran: string; exitCode: number } },
): Verdict {
  const v = baseVerdict(node, attempts);
  return {
    ...v,
    status: 'failed',
    evidence: { ...v.evidence, ...(extra.gate ? { gate: extra.gate } : {}) },
  };
}

function dedup(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}
