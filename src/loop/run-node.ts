import { auditGateTampering, buildAuditPrompt, extractAuditJson } from '../core/audit-egress.ts';
import { classify } from '../core/classify.ts';
import {
  AuditParseError,
  GateFailedError,
  IsolateCatastrophicError,
  PlanInvalidError,
} from '../core/errors.ts';
import { checkDiffHygiene } from '../core/hygiene.ts';
import { type AuditResult, AuditResultSchema, type Node, type Verdict } from '../core/plan.ts';
import type { AuditRecord, GateRecord } from '../core/receipt.ts';
import { DEFAULT_WORKER_PROVIDER } from '../core/validate.ts';
import type { ConductorDeps, Isolation, WorkerResult } from './deps.ts';
import { guardedExec, runWork } from './run-work.ts';

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
  // The live isolation, handed to run-plan for the commit-then-dispose
  // (done) or quarantine-then-dispose (terminal failed/dead) sequence.
  // Absent for blocked verdicts (disposed here — the worker never finished a
  // turn, there is nothing worth keeping) and for never-isolated failures.
  iso?: Isolation;
  stagedFiles?: string[];
  // Last failing gate's output tail (capped) — journal-only diagnostics; the
  // Verdict contract is untouched. The 2026-08-17 canary debug needed a
  // wrapper script to see WHY a command gate failed; never again.
  gateOutputTail?: string;
  // The final attempt's conductor-ladder gate records in run order, and the
  // audit's tri-state records — the receipt's raw facts (§D). A 'skip' audit
  // record means "never adjudicated" (auditor outage, egress exhaustion),
  // distinct from "checked and failed".
  gates?: GateRecord[];
  audit?: AuditRecord[];
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

  // Terminal failed/dead verdicts hand the live tree back to the caller so
  // run-plan can quarantine the evidence before disposing. Blocked verdicts
  // dispose here — the worker never finished a turn; there is nothing to keep.
  // Every hand-back carries the final attempt's gate ladder + audit records +
  // staged set so run-plan can mint the receipt from frozen facts (§D).
  function handBack(result: RunNodeResult): RunNodeResult {
    const live = iso;
    iso = null;
    const out: RunNodeResult = {
      ...result,
      gates,
      ...(auditRecords !== undefined ? { audit: auditRecords } : {}),
      ...(result.stagedFiles === undefined && lastStaged !== undefined
        ? { stagedFiles: lastStaged }
        : {}),
    };
    return live === null ? out : { ...out, iso: live };
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
  // Receipt facts (§D), reset per attempt: the ladder's gate records in run
  // order, the audit's records, and the staged set once staging happened.
  let gates: GateRecord[] = [];
  let auditRecords: AuditRecord[] | undefined;
  let lastStaged: string[] | undefined;

  try {
    for (;;) {
      attempts += 1;
      gates = [];
      auditRecords = undefined;
      lastStaged = undefined;

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
        const { output, exitCode } = await guardedExec(deps.exec, node.setup, { cwd, timeoutMs });
        gates.push({ gate: 'setup', exitCode });
        if (exitCode !== 0) {
          const settle = settleRetryable(
            node,
            attempts,
            maxAttempts,
            { gate: { ran: node.setup, exitCode } },
            output,
          );
          if (settle) return handBack(settle);
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
          if (decision.settle) return handBack(decision.settle);
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
          return handBack({ verdict: { ...baseVerdict(node, attempts), status: 'dead' } });
        }
        // timeout → retryable (reuse tree); anything else terminal.
        if (klass === 'retryable' && attempts < maxAttempts) {
          evidence = `previous attempt ended: ${result.reason}`;
          continue;
        }
        return handBack({
          verdict: failedVerdict(node, attempts, {
            gate: { ran: `wait:${result.reason}`, exitCode: -1 },
          }),
        });
      }

      // ── marker gate (ledger C1) ─────────────────────────────────────────────
      const markers = await deps.isolate.scanMarkers(cwd);
      gates.push({ gate: 'marker', exitCode: markers.length > 0 ? -1 : 0 });
      if (markers.length > 0) {
        const settle = settleRetryable(node, attempts, maxAttempts, {
          gate: { ran: 'marker', exitCode: -1 },
        });
        if (settle) return handBack(settle);
        evidence = `Conflict markers remain in:\n${markers.join('\n')}\nResolve the conflict markers.`;
        continue;
      }

      // ── scoped staging (ledger C2 — nothing re-stages after this) ────────────
      const changed = await deps.isolate.changedFiles(cwd);
      const stagedFiles = dedup([...result.filesTouched, ...changed]);
      await deps.isolate.stage(cwd, stagedFiles);
      lastStaged = stagedFiles;

      // ── hygiene (§E) ─────────────────────────────────────────────────────────
      // Pure scans over the staged diff: empty-diff attribution (agent work
      // claiming done on nothing), a high-precision secrets battery, and the
      // bulk-deletion tripwire with its deterministic re-state escape. All
      // retryable with evidence; terminal failure quarantines like any gate.
      {
        const hygiene = checkDiffHygiene({
          workKind:
            'command' in node.work ? 'command' : 'phases' in node.work ? 'phases' : 'prompt',
          stagedFiles,
          diff: stagedFiles.length > 0 ? await deps.isolate.stagedDiff(cwd) : '',
          numstat: stagedFiles.length > 0 ? await deps.isolate.stagedNumstat(cwd) : [],
          finalMessage: result.finalMessage,
        });
        gates.push({
          gate: hygiene === null ? 'hygiene' : `hygiene:${hygiene.kind}`,
          exitCode: hygiene === null ? 0 : -1,
        });
        if (hygiene !== null) {
          const settle = settleRetryable(
            node,
            attempts,
            maxAttempts,
            { gate: { ran: `hygiene:${hygiene.kind}`, exitCode: -1 } },
            hygiene.evidence,
          );
          if (settle) return handBack(settle);
          evidence = hygiene.evidence;
          continue; // retryable — SAME tree; the worker can fix its diff
        }
      }

      // ── smoke ────────────────────────────────────────────────────────────────
      if (node.accept.smoke) {
        const { output, exitCode } = await guardedExec(deps.exec, node.accept.smoke, {
          cwd,
          timeoutMs,
        });
        gates.push({ gate: 'smoke', exitCode });
        if (exitCode !== 0) {
          const settle = settleRetryable(
            node,
            attempts,
            maxAttempts,
            { gate: { ran: node.accept.smoke, exitCode } },
            output,
          );
          if (settle) return handBack(settle);
          evidence = gateEvidence('smoke', exitCode, output);
          continue;
        }
      }

      // ── audit ────────────────────────────────────────────────────────────────
      let output: AuditResult | undefined;
      if (node.accept.audit) {
        // SEC4a — refuse to run a gate the builder rewrote. A repo-local audit
        // script the worker touched is not the plan's gate anymore; retry with
        // revert evidence (an honest formatter-touch is recoverable), terminal
        // at maxAttempts. Checked against this attempt's staged set, so a
        // reverted file (clean vs HEAD) passes on the retry.
        // v1.1.5 selfIntegrity: the audit command carries its own
        // fitness-function pin (scoreboard-normalized) and an out-of-tree
        // binary — the phase-2 hub collision's fix. Declared → the token rule
        // stands down; the audit itself refuses real tampering ("base is
        // stale"). Undeclared commands keep the strict rule.
        const tampered = node.accept.audit.selfIntegrity
          ? []
          : auditGateTampering(node.accept.audit.command, stagedFiles);
        if (tampered.length > 0) {
          gates.push({ gate: 'audit-tamper', exitCode: -1 });
          const tamperMsg = `${node.accept.audit.command} (gate tampered: ${tampered.join(', ')})`;
          const settle = settleRetryable(
            node,
            attempts,
            maxAttempts,
            {
              gate: {
                ran: tamperMsg,
                exitCode: -1,
              },
            },
            tamperMsg,
          );
          if (settle) return handBack(settle);
          evidence =
            `You modified the audit gate file(s): ${tampered.join(', ')}. ` +
            "Revert them to their original content — the audit must run the plan's " +
            'pristine gate, not yours.';
          continue; // retryable — SAME tree; the builder can restore the gate
        }

        const auditOutcome = await runAudit(node, cwd, deps, timeoutMs);
        if (auditOutcome.kind === 'parse-exhausted') {
          // Never adjudicated — the receipt records skip, not fail (§D).
          auditRecords = [
            {
              check: '(audit)',
              verdict: 'skip',
              reasons: ['audit egress unparseable after reaudit budget — never adjudicated'],
            },
          ];
          return handBack({
            verdict: failedVerdict(node, attempts, {
              // node.accept.audit is defined inside this block.
              gate: { ran: `${node.accept.audit.command} (egress unparseable)`, exitCode: -1 },
            }),
          });
        }
        if (auditOutcome.kind === 'worker-fault') {
          // The auditor died / timed out / blocked — it never returned a verdict.
          // Distinct from a fail verdict; record the reason for the journal.
          auditRecords = [
            {
              check: '(audit)',
              verdict: 'skip',
              reasons: [`auditor ${auditOutcome.reason} — never adjudicated`],
            },
          ];
          return handBack({
            verdict: failedVerdict(node, attempts, {
              gate: {
                ran: `${node.accept.audit.command} (auditor ${auditOutcome.reason})`,
                exitCode: -1,
              },
            }),
          });
        }
        auditRecords = auditOutcome.result.verdicts.map((v) => ({
          check: v.check,
          verdict: v.verdict,
          reasons: v.reasons,
        }));
        if (auditOutcome.kind === 'fail') {
          const settle = settleRetryable(node, attempts, maxAttempts, {});
          if (settle) return handBack(settle);
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
      return {
        verdict,
        iso: liveIso,
        stagedFiles,
        gates,
        ...(auditRecords !== undefined ? { audit: auditRecords } : {}),
      };
    }
  } finally {
    // Safety net: any tree still held by a thrown/early path is disposed.
    if (iso !== null) await disposeQuiet(iso);
  }
}

// ── audit ──────────────────────────────────────────────────────────────────

type AuditOutcome =
  | { kind: 'pass'; result: AuditResult }
  // fail carries the parsed result too — the receipt relays verdicts verbatim (§D).
  | { kind: 'fail'; evidence: string; result: AuditResult }
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
      if (classify({ kind: 'error', error: asError(err) }) === 'reaudit') {
        // #13: the raw auditor message is the ONE artifact that diagnoses an
        // egress failure — keep it (capped) or debug blind, as the phase-2
        // hub rerun proved.
        await deps.journal.append({
          event: 'audit-egress-unparseable',
          node: node.id,
          reaudit,
          egress: res.finalMessage.slice(-2000),
        });
        continue;
      }
      // A non-reaudit error from parsing is unexpected; rethrow honestly.
      throw err;
    }

    const failing = parsed.verdicts.filter((v) => v.verdict === 'fail');
    if (failing.length > 0) {
      return { kind: 'fail', evidence: auditFailEvidence(failing), result: parsed };
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
  const settle = settleRetryable(
    node,
    attempts,
    maxAttempts,
    { gate: { ran: gateRanLabel(node, err), exitCode: err.exitCode } },
    err.evidence,
  );
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
  outputTail?: string,
): RunNodeResult | undefined {
  if (attempts < maxAttempts) return undefined;
  return {
    verdict: failedVerdict(node, attempts, extra),
    ...(outputTail !== undefined && outputTail.length > 0
      ? { gateOutputTail: outputTail.slice(-2000) }
      : {}),
  };
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
