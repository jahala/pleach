import {
  auditGateTampering,
  buildAuditPrompt,
  EXPECTED_EGRESS,
  extractAuditJson,
} from '../core/audit-egress.ts';
import { classify, type GateFault, gateFault } from '../core/classify.ts';
import { partitionDelivery } from '../core/delivery.ts';
import {
  AuditParseError,
  GateCannotRunError,
  GateFailedError,
  type GateKind,
  IsolateCatastrophicError,
  PlanInvalidError,
} from '../core/errors.ts';
import { checkDiffHygiene, type HygieneFailure } from '../core/hygiene.ts';
import { type AuditResult, AuditResultSchema, type Node, type Verdict } from '../core/plan.ts';
import { type AuditRecord, type GateRecord, sha256Hex } from '../core/receipt.ts';
import { parseSarif } from '../core/sarif.ts';
import { DEFAULT_WORKER_PROVIDER } from '../core/validate.ts';
import type { ConductorDeps, ExecResult, Isolation, WorkerResult } from './deps.ts';
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

// The quarantined tree an attempt stands on (D17): the sha it was taken at,
// and the stat of what it holds when the seam could show one. run-plan resolves
// it; run-node hands it to the worker that picks the work up.
export interface ResumedFrom {
  sha: string;
  stat?: string;
  // The red phase index that tree already carries a seal for (D13), when the
  // close that kept it recorded one. The resumed attempt re-enters the phase
  // ladder after it: a tree holding the failing test cannot demonstrate it
  // failing again, and re-running that phase would seal a lie — or, over a tree
  // nothing changed in, nothing at all.
  redSealedAt?: number;
}

export interface RunNodeOpts {
  defaultTimeoutMs: number;
  // Teardown signal (D12) — interrupts worker waits; everything else settles.
  signal?: AbortSignal;
  // The conductor's idle timeout (D16) — carried into every wait this node
  // makes, the build worker's and the auditor's alike: a wedged worker of
  // either kind ends here rather than at the attempt clock.
  idleMs?: number;
  // The run's second cast (D17): who takes over when an attempt comes back
  // `dead`. Conductor-level, never a plan field — which provider stands in for
  // a dead one is the operator's call for this run, not a fact about the node.
  fallbackProvider?: string;
  // The quarantined tree baseRefs[0] checks out (D17), when this node resumed
  // one. Every attempt that isolates lands inside that work, so the worker is
  // told where it came from before it writes over it. Absent for a fresh build.
  resumedFrom?: ResumedFrom;
  // Called as a build worker spawns (D19) — the cast running this node's work,
  // never the auditor. The verdict line says whether the cast ever ran, and a
  // node that throws has no result to say it with, so the fact leaves here.
  onSpawn?: () => void;
}

export interface RunNodeResult {
  verdict: Verdict;
  // The live isolation, handed to run-plan for the commit-then-dispose
  // (done) or quarantine-then-dispose (terminal failed/dead/blocked/aborted)
  // sequence. Blocked and aborted hand their tree back too (D11, D16) — workers
  // edit files mid-turn, so an unfinished turn is unfinished work, not nothing.
  // Absent only for never-isolated failures.
  iso?: Isolation;
  // What the index held after the final attempt staged (D19) — the receipt's
  // count. Absent when that attempt never reached staging.
  stagedFiles?: string[];
  // What the runner saw at an abnormal end (D11) — passed through to the
  // journal verdict, never fabricated.
  runnerDetail?: { paneTail?: string; processExit?: number };
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
  // The smoke gate's stdout, present only when it parsed as a findings log
  // (ledger D14) — the very bytes the final attempt's `artifactSha` hashes,
  // carried so settle can keep them beside the receipt before the tree goes.
  // Journal/settle material only; the Verdict contract is untouched.
  smokeStdout?: string;
  // The final attempt's hand-back: the message the work ended with, verbatim
  // (ledger D17). Read by nobody here — settle keeps it beside the receipt and
  // the session it came from is killed moments later. Journal/settle material
  // only, like smokeStdout; absent when the attempt never got a result.
  handback?: string;
  // The red phase index the tree this attempt hands back has sealed (D13),
  // when it sealed one. Journal/settle material like `handback`: the receipt
  // records it, so an attempt later seeded from that tree re-enters the phase
  // ladder where the tree actually left off instead of where a build starts.
  redSealedAt?: number;
  // Why the node settled where it did, when the reason is a scheduling
  // decision rather than a gate (D17): an attempt left unspent because the
  // provider that would have run it is the one already known dead, or a
  // fallback refused for breaking audit diversity — or a gate that could not
  // run at all, named as the plan's or the environment's fault (D19). Rides
  // the verdict's journal line as `detail`; the Verdict contract is untouched.
  verdictDetail?: string;
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

  // Every terminal verdict (failed/dead/blocked/aborted) hands the live tree
  // back so run-plan can quarantine the evidence before disposing — blocked
  // since D11 and aborted since D16: workers edit files mid-turn, so an
  // unfinished turn holds work, and a halted run must not throw it away.
  // Every hand-back carries the final attempt's gate ladder + audit records +
  // staged set so run-plan can mint the receipt from frozen facts (§D).
  function handBack(result: RunNodeResult): RunNodeResult {
    const live = iso;
    iso = null;
    const out: RunNodeResult = {
      ...result,
      gates,
      ...(smokeStdout !== undefined ? { smokeStdout } : {}),
      ...(handback !== undefined ? { handback } : {}),
      ...(redSealedAt !== undefined ? { redSealedAt } : {}),
      ...(auditRecords !== undefined ? { audit: auditRecords } : {}),
      ...(result.stagedFiles === undefined && lastStaged !== undefined
        ? { stagedFiles: lastStaged }
        : {}),
    };
    return live === null ? out : { ...out, iso: live };
  }

  // A worker that wrote BLOCKED.md at the root has finished and explained
  // (D21), however its attempt then ended — a stop, a red command, a prompt it
  // sat at, the clock: no gate runs over the explanation, and no retry asks for
  // it again in the very tree that holds it. The live tree goes back like
  // every blocked hand-back (D11), so settle quarantines it — BLOCKED.md
  // included, because it is the evidence. Null when the tree holds no file.
  async function settleIfBlocked(
    cwd: string,
    telemetry: Verdict['telemetry'],
    extra: Pick<RunNodeResult, 'runnerDetail'> = {},
  ): Promise<RunNodeResult | null> {
    const text = await deps.isolate.readBlocked(cwd);
    if (text === null) return null;
    const base = baseVerdict(node, attempts);
    return handBack({
      verdict: {
        ...base,
        status: 'blocked',
        evidence: { ...base.evidence, blockedReason: blockedReasonOf(text) },
        telemetry,
      },
      ...extra,
    });
  }

  // Resolved-provider diversity preflight (binding prose) — before any spawn.
  const preflight = auditDiversityRefusal(node, node.worker.provider ?? DEFAULT_WORKER_PROVIDER);
  if (preflight !== undefined) throw new PlanInvalidError([preflight]);

  // Who is cast for the next attempt. The plan's cast until a `dead` attempt
  // hands the node to the run's fallback (D17) — and a model pin names a model
  // of the provider that died, so it goes with it.
  let cast: { provider?: string; model?: string } = {
    provider: node.worker.provider,
    model: node.worker.model,
  };

  const timeoutMs = node.policy.timeoutMs ?? opts.defaultTimeoutMs;
  const maxAttempts = node.policy.maxAttempts;

  // Tree lifecycle across attempts: retryable reuses `iso`; dead+resume
  // disposes and re-isolates. Every verdict that settles hands `iso` to the
  // caller — done for the commit, the rest for the quarantine — so the `finally`
  // below only ever disposes a tree an early or thrown path still holds.
  let iso: Isolation | null = null;
  // The phase the CURRENT tree has sealed a red commit for (D13), if any. It
  // belongs to the tree, not to the node: a retry that reuses the tree re-enters
  // after that phase, and a re-isolated tree (dead+resume) earns whatever its
  // base carries — nothing for a build from its dependencies, and for a tree
  // checked out of a quarantine (D17) the seal that tree already holds.
  let redSealedAt: number | undefined;
  // Evidence threaded into the next attempt's re-prompt (A3). undefined on the
  // first attempt.
  let evidence: string | undefined;
  let attempts = 0;
  // Receipt facts (§D), reset per attempt: the ladder's gate records in run
  // order, the audit's records, and the staged set once staging happened.
  let gates: GateRecord[] = [];
  let auditRecords: AuditRecord[] | undefined;
  let lastStaged: string[] | undefined;
  // The smoke gate's findings log, when this attempt's gate wrote one (D14).
  let smokeStdout: string | undefined;
  // What this attempt's work handed back (D17) — the builder's final message,
  // never the auditor's, which is egress the loop parses rather than work a
  // worker produced.
  let handback: string | undefined;

  try {
    for (;;) {
      attempts += 1;
      gates = [];
      auditRecords = undefined;
      lastStaged = undefined;
      smokeStdout = undefined;
      handback = undefined;

      // ── isolate (or reuse the tree for a retryable retry) ───────────────────
      // Whether THIS attempt built its tree: a retryable retry reuses the one
      // the last attempt worked in, and a worker already inside a resumed tree
      // does not need telling where it came from again.
      let isolated = false;
      if (iso === null) {
        // Every isolation of this node checks out the same baseRefs, so a
        // resumed node's fresh tree carries the quarantine's seal again.
        redSealedAt = opts.resumedFrom?.redSealedAt;
        isolated = true;
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
      const promptEvidence = mergeEvidence(
        evidence,
        mergeEvidence(isolated ? resumeEvidence(opts.resumedFrom) : undefined, firstPromptExtra),
      );

      // ── setup ───────────────────────────────────────────────────────────────
      if (node.setup) {
        const { output, exitCode } = await execGateWithRetry(deps, node.id, 'setup', node.setup, {
          cwd,
          timeoutMs,
        });
        gates.push({ gate: 'setup', exitCode });
        const fault = gateFault(exitCode);
        if (fault !== null) {
          return handBack(settleCannotRun(node, attempts, node.setup, exitCode, fault, output));
        }
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
        'command' in node.work ? null : await deps.runner.spawnWorker({ ...cast, cwd });
      if (worker !== null) opts.onSpawn?.();
      let result: WorkerResult;
      try {
        result = await runWork(node, worker, deps.exec, cwd, {
          timeoutMs,
          evidence: promptEvidence,
          signal: opts.signal,
          idleMs: opts.idleMs,
          redSealedAt,
          sealRed: async (red, exitCode, phaseIndex) => {
            await sealRedPhase(node, cwd, deps, red, exitCode);
            redSealedAt = phaseIndex;
          },
          wroteBlocked: async () => (await deps.isolate.readBlocked(cwd)) !== null,
        });
      } catch (err) {
        await worker?.kill();
        if (err instanceof GateCannotRunError) {
          return handBack(
            settleCannotRun(
              node,
              attempts,
              gateRanLabel(node, err.gate),
              err.exitCode,
              err.fault,
              err.output,
            ),
          );
        }
        if (err instanceof GateFailedError) {
          const blocked = await settleIfBlocked(cwd, {});
          if (blocked !== null) return blocked;
          const decision = handleGate(node, attempts, maxAttempts, err);
          if (decision.settle) return handBack(decision.settle);
          evidence = decision.evidence;
          continue; // retryable — SAME tree
        }
        throw err;
      }
      await worker?.kill();
      handback = result.finalMessage;

      // ── non-stop reasons ──────────────────────────────────────────────────
      if (result.reason !== 'stop') {
        // A runner that named nothing ended abnormally without saying how —
        // classify has always read that as an abort; the gate string says so too.
        const reason = result.reason ?? 'aborted';
        const klass = classify({ kind: 'worker', reason });
        // What the runner saw at the abnormal end, when it could see anything
        // (D11) — rides every terminal hand-back below, never fabricated.
        const runnerDetail = {
          ...(result.paneTail !== undefined ? { paneTail: result.paneTail } : {}),
          ...(result.processExit !== undefined ? { processExit: result.processExit } : {}),
        };
        const detail = Object.keys(runnerDetail).length > 0 ? { runnerDetail } : {};
        // A dead end is about the provider (D17) and an aborted one about the
        // run (D16); every other end left the work's own tree to read.
        if (klass !== 'dead' && reason !== 'aborted') {
          const blocked = await settleIfBlocked(cwd, result.telemetry, detail);
          if (blocked !== null) return blocked;
        }
        if (klass === 'blocked') {
          // Hand the tree back (D11): workers edit files mid-turn — 9m40s of
          // work once died with the "nothing worth keeping" theory here.
          const base = baseVerdict(node, attempts);
          return handBack({
            verdict: {
              ...base,
              status: 'blocked',
              evidence: { ...base.evidence, blockedReason: result.message },
              telemetry: result.telemetry,
            },
            ...detail,
          });
        }
        if (klass === 'dead') {
          // A dead attempt says the provider is gone, not that the work is
          // wrong (D17) — so the next attempt only happens on a DIFFERENT
          // provider. The run's fallback is that second cast; with no usable
          // one, the attempt that would have re-run the same outage is not
          // spent at all, and the verdict's journal line says so.
          let unspent: string | undefined;
          if (node.policy.onDead === 'resume' && attempts < maxAttempts) {
            const resolved = cast.provider ?? DEFAULT_WORKER_PROVIDER;
            const fallback = opts.fallbackProvider;
            if (fallback === undefined) {
              unspent = NO_FALLBACK;
            } else if (fallback === resolved) {
              unspent = `fallback provider '${fallback}' is the same dead provider`;
            } else {
              // The diversity rule is the gate's whole worth: a fallback that
              // is the auditor would leave one provider grading its own work,
              // green and meaningless. Refuse the cast, keep the tree.
              const refusal = auditDiversityRefusal(node, fallback);
              if (refusal !== undefined) {
                return handBack({
                  verdict: failedVerdict(node, attempts, {
                    gate: { ran: `fallback provider '${fallback}': ${refusal}`, exitCode: -1 },
                  }),
                  verdictDetail: refusal,
                  ...detail,
                });
              }
              cast = { provider: fallback };
              await disposeQuiet(iso);
              iso = null; // force re-isolate (fresh tree)
              evidence = undefined;
              continue;
            }
          }
          const base = baseVerdict(node, attempts);
          return handBack({
            verdict: {
              ...base,
              status: 'dead',
              // Name the end (D11) — a bare 'dead' cost bandung a manual
              // reproduction to diagnose.
              evidence: { ...base.evidence, gate: { ran: 'wait:dead', exitCode: -1 } },
            },
            ...(unspent !== undefined ? { verdictDetail: unspent } : {}),
            ...detail,
          });
        }
        if (reason === 'aborted') {
          // The run's own signal ended this wait: the node did not lose, the
          // run stopped holding it (D16). The hand-back is every other
          // terminal reason's — live tree, so settle quarantines the work and
          // writes the receipt — and only the status differs, which is what
          // keeps a halted node out of the failed bucket.
          const base = baseVerdict(node, attempts);
          return handBack({
            verdict: {
              ...base,
              status: 'aborted',
              evidence: { ...base.evidence, gate: { ran: 'wait:aborted', exitCode: -1 } },
            },
            ...detail,
          });
        }
        // timeout → retryable (reuse tree); anything else terminal.
        if (klass === 'retryable' && attempts < maxAttempts) {
          evidence = `previous attempt ended: ${reason}`;
          continue;
        }
        return handBack({
          verdict: failedVerdict(node, attempts, {
            gate: { ran: `wait:${reason}`, exitCode: -1 },
          }),
          ...detail,
        });
      }

      // ── BLOCKED.md (D21) — before any gate runs over the explanation ───────
      const blocked = await settleIfBlocked(cwd, result.telemetry);
      if (blocked !== null) return blocked;

      // ── marker gate (ledger C1) ─────────────────────────────────────────────
      const markers = await deps.isolate.scanMarkers(cwd);
      gates.push({ gate: 'marker', exitCode: markers.length > 0 ? -1 : 0 });
      if (markers.length > 0) {
        const settle = settleRetryable(node, attempts, maxAttempts, {
          gate: { ran: 'marker', exitCode: -1 },
        });
        if (settle) return handBack(settle);
        evidence = markerEvidence(markers);
        continue;
      }

      // ── scoped staging (ledger C2 — nothing re-stages after this) ────────────
      const stagedFiles = await collectDelivery(deps, node, cwd, result);
      await deps.isolate.stage(cwd, stagedFiles);
      // The receipt counts what the index holds (D19): a path the worker named
      // but never changed was handed to staging and staged nothing.
      const indexed = await deps.isolate.stagedPaths(cwd);
      lastStaged = indexed;

      // ── hygiene (§E) ─────────────────────────────────────────────────────────
      // Pure scans over the staged diff: empty-diff attribution (agent work
      // claiming done on nothing), a high-precision secrets battery, and the
      // bulk-deletion tripwire with its deterministic re-state escape. All
      // retryable with evidence; terminal failure quarantines like any gate.
      {
        const hygiene = await scanHygiene(deps, node, cwd, stagedFiles, result.finalMessage);
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
        const { output, stdout, exitCode } = await execGateWithRetry(
          deps,
          node.id,
          'smoke',
          node.accept.smoke,
          { cwd, timeoutMs },
        );
        // A findings log outlives the tree (D14). The parse decides, not the
        // exit code: a `weeder check --strict` that fails wrote the log that
        // says why. The hash is over the stdout bytes verbatim — one sha256,
        // sealed here and cited by whatever keeps the file.
        const isFindingsLog = parseSarif(stdout) !== null;
        if (isFindingsLog) smokeStdout = stdout;
        gates.push({
          gate: 'smoke',
          exitCode,
          ...(isFindingsLog ? { artifactSha: sha256Hex(stdout) } : {}),
        });
        const fault = gateFault(exitCode);
        if (fault !== null) {
          return handBack(
            settleCannotRun(node, attempts, node.accept.smoke, exitCode, fault, output),
          );
        }
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
        const ladder = await runAuditLadder(node, cwd, stagedFiles, deps, timeoutMs, {
          signal: opts.signal,
          idleMs: opts.idleMs,
        });
        if (ladder.kind === 'tampered') {
          gates.push({ gate: 'audit-tamper', exitCode: -1 });
          const tamperMsg = `${node.accept.audit.command} (gate tampered: ${ladder.files.join(', ')})`;
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
            `You modified the audit gate file(s): ${ladder.files.join(', ')}. ` +
            "Revert them to their original content — the audit must run the plan's " +
            'pristine gate, not yours.';
          continue; // retryable — SAME tree; the builder can restore the gate
        }
        auditRecords = ladder.records;
        if (ladder.kind === 'unadjudicated') {
          const base = baseVerdict(node, attempts);
          return handBack({
            verdict: {
              ...base,
              // An auditor the run's own signal cut off is an abort, not a
              // failed audit (D16) — the build's work rides back either way.
              status: ladder.aborted ? 'aborted' : 'failed',
              evidence: {
                ...base.evidence,
                gate: { ran: ladder.gateRan, exitCode: -1 },
              },
            },
          });
        }
        if (ladder.kind === 'fail') {
          const settle = settleRetryable(node, attempts, maxAttempts, {});
          if (settle) return handBack(settle);
          evidence = ladder.evidence;
          continue; // audit-fail → re-prompt a FRESH build worker, SAME tree
        }
        output = ladder.result;
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
        stagedFiles: indexed,
        gates,
        ...(smokeStdout !== undefined ? { smokeStdout } : {}),
        ...(handback !== undefined ? { handback } : {}),
        ...(redSealedAt !== undefined ? { redSealedAt } : {}),
        ...(auditRecords !== undefined ? { audit: auditRecords } : {}),
      };
    }
  } finally {
    // Safety net: any tree still held by a thrown/early path is disposed.
    if (iso !== null) await disposeQuiet(iso);
  }
}

// ── audit ──────────────────────────────────────────────────────────────────

// The audit ladder: the SEC4a gate-integrity rule, then the auditor itself
// bounded by the reaudit budget. The node ladder runs it as its last gate and
// `pleach audit` runs it alone over a quarantined tree (D17) — one ladder, two
// callers, so a re-adjudication is judged by exactly what the run judged it by.
// What the callers differ on is what to DO with the answer: run-node retries
// what a retry can fix, the verb closes or re-quarantines what it was handed.
export type AuditLadderOutcome =
  // The gate names a file this attempt delivered: the plan's check is not the
  // plan's anymore, so no auditor is spawned at all.
  | { kind: 'tampered'; files: string[] }
  | { kind: 'pass'; result: AuditResult; records: AuditRecord[] }
  | { kind: 'fail'; evidence: string; records: AuditRecord[] }
  // The auditor never adjudicated: its egress never parsed within the budget,
  // or it died, timed out, or was cut off mid-wait. `gateRan` names which for
  // the verdict's gate record; `aborted` marks the run's own signal (D16).
  | { kind: 'unadjudicated'; records: AuditRecord[]; gateRan: string; aborted: boolean };

export async function runAuditLadder(
  node: Node,
  cwd: string,
  stagedFiles: readonly string[],
  deps: ConductorDeps,
  timeoutMs: number,
  wait: { signal?: AbortSignal; idleMs?: number },
): Promise<AuditLadderOutcome> {
  // node.accept.audit is defined by the caller's guard.
  const audit = node.accept.audit as NonNullable<Node['accept']['audit']>;

  // SEC4a — refuse to run a gate the builder rewrote. A repo-local audit
  // script the worker touched is not the plan's gate anymore. Checked against
  // this attempt's staged set, so a reverted file (clean vs HEAD) passes on the
  // retry — and a caller that staged nothing (the re-audit of a tree an auditor
  // was already admitted to) flags nothing, because nothing was delivered here.
  // v1.1.5 selfIntegrity: the audit command carries its own fitness-function
  // pin (scoreboard-normalized) and an out-of-tree binary — the phase-2 hub
  // collision's fix. Declared → the token rule stands down; the audit itself
  // refuses real tampering ("base is stale"). Undeclared commands keep the
  // strict rule.
  const tampered = audit.selfIntegrity ? [] : auditGateTampering(audit.command, stagedFiles);
  if (tampered.length > 0) return { kind: 'tampered', files: tampered };

  const outcome = await runAudit(node, cwd, deps, timeoutMs, wait);
  // Never adjudicated — the receipt records skip, not fail (§D).
  if (outcome.kind === 'parse-exhausted') {
    return {
      kind: 'unadjudicated',
      records: [neverAdjudicated('audit egress unparseable after reaudit budget')],
      gateRan: `${audit.command} (egress unparseable)`,
      aborted: false,
    };
  }
  // The auditor died / timed out / was held at a prompt — it never returned a
  // verdict. Distinct from a fail verdict; the reason is recorded as such.
  if (outcome.kind === 'worker-fault') {
    return {
      kind: 'unadjudicated',
      records: [neverAdjudicated(`auditor ${outcome.reason}`)],
      gateRan: `${audit.command} (auditor ${outcome.reason})`,
      aborted: outcome.reason === 'aborted',
    };
  }
  const records: AuditRecord[] = outcome.result.verdicts.map((v) => ({
    check: v.check,
    verdict: v.verdict,
    reasons: v.reasons,
  }));
  if (outcome.kind === 'fail') return { kind: 'fail', evidence: outcome.evidence, records };
  return { kind: 'pass', result: outcome.result, records };
}

function neverAdjudicated(why: string): AuditRecord {
  return { check: '(audit)', verdict: 'skip', reasons: [`${why} — never adjudicated`] };
}

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
  wait: { signal?: AbortSignal; idleMs?: number },
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
      res = await worker.wait({ timeoutMs, signal: wait.signal, idleMs: wait.idleMs });
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
          expected: EXPECTED_EGRESS,
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

// The exec gates (setup, smoke) get ONE gate-only retry in the same
// provisioned worktree before a red becomes worker evidence — the land gate's
// flaky-retry doctrine at node level (D10, decker wave 2): a worker prompted
// to fix a failure that wasn't its fault "fixes" something that isn't broken,
// and good work ages in quarantine. Deterministic scans (marker, hygiene)
// never flake and get no retry; the audit has its own reaudit budget. Nor
// does a gate that never ran (D19): the guard answers from the command string
// and a missing binary stays missing, so running it again learns nothing.
export async function execGateWithRetry(
  deps: ConductorDeps,
  nodeId: string,
  gate: 'setup' | 'smoke',
  command: string,
  opts: { cwd: string; timeoutMs: number },
): Promise<ExecResult> {
  const first = await guardedExec(deps.exec, command, opts);
  if (first.exitCode === 0 || gateFault(first.exitCode) !== null) return first;
  await deps.journal.append({ event: 'gate-retry', node: nodeId, gate });
  const retry = await guardedExec(deps.exec, command, opts);
  if (retry.exitCode === 0) {
    await deps.journal.append({ event: 'gate-flaky', node: nodeId, gate });
  }
  return retry; // green: proceed; red: the RETRY run is the evidence.
}

// ── the deterministic scans (shared by the close and the seal) ───────────────
//
// Neither scan runs a command, so neither has an exit code of its own: -1 is
// the ladder's "pleach's own finding" marker, the value the close's gate
// records already carry.
const SCAN_EXIT = -1;

function markerEvidence(markers: readonly string[]): string {
  return `Conflict markers remain in:\n${markers.join('\n')}\nResolve the conflict markers.`;
}

// The hygiene battery over a staged set. The diff and numstat are read only
// when something is staged — an empty index has neither, and the empty-diff
// rule already speaks for that case.
async function scanHygiene(
  deps: ConductorDeps,
  node: Node,
  cwd: string,
  stagedFiles: readonly string[],
  finalMessage: string,
): Promise<HygieneFailure | null> {
  return checkDiffHygiene({
    workKind: 'command' in node.work ? 'command' : 'phases' in node.work ? 'phases' : 'prompt',
    stagedFiles,
    diff: stagedFiles.length > 0 ? await deps.isolate.stagedDiff(cwd) : '',
    numstat: stagedFiles.length > 0 ? await deps.isolate.stagedNumstat(cwd) : [],
    finalMessage,
  });
}

// ── collection (ledger D14) ──────────────────────────────────────────────────
//
// What a node stages: what the worker reported touching ∪ what the tree shows
// changed, MINUS what is not delivery. The manifest is a report, not a
// promise — it names absolute paths, scratch probes the work order itself
// asked for, and files git ignores; `git add` of any of those exits non-zero,
// and a collection that dies takes the FINISHED node's tree with it
// (jahala/pleach#74, #79 — forty minutes of a build lost). So the pure
// predicate decides what the path alone settles, the seam answers what only
// git's rules can, and the journal names everything set aside. Nothing about
// a set-aside path can fail the node: they are removed, not refused.
async function collectDelivery(
  deps: ConductorDeps,
  node: Node,
  cwd: string,
  result: WorkerResult,
): Promise<string[]> {
  const changed = await deps.isolate.changedFiles(cwd);
  const { keep, setAside } = partitionDelivery(dedup([...result.filesTouched, ...changed]), cwd);
  // dedup AFTER normalisation: the same file named absolutely by the manifest
  // and relatively by the tree is one delivery, not two.
  const candidates = dedup(keep);
  const ignored = await deps.isolate.ignored(cwd, candidates);
  const aside = [...setAside, ...ignored];
  if (aside.length > 0) {
    await deps.journal.append({ event: 'set-aside', node: node.id, paths: aside });
  }
  return candidates.filter((f) => !ignored.includes(f));
}

// ── the red-phase seal (D13) ─────────────────────────────────────────────────
//
// What the close does, in miniature: the red phase's files (what the worker
// reported touching ∪ what the tree shows changed) are scoped-staged, put
// through the close's own two deterministic scans, and committed on the
// detached HEAD. No branch moves — node/<id> is published at settle only — so
// the close's commit stacks on this one and the history reads base → red →
// verified. The close's own scoped staging then picks up only what changed
// after the seal, HEAD having moved.
//
// The scans are not the close's to run alone: a commit made before them is one
// the close can never take back. Conflict markers sealed into the red state
// mint a history nobody can build (`weeder bite` checks that commit out), and a
// credential sealed there is compromised the moment node/<id> publishes — the
// close would then be gating a leak that is already a parent of the verified
// commit. Both refusals are ladder gate failures (`marker`, `hygiene:<kind>`)
// carrying the evidence and the labels the close records, so they retry in the
// same tree and leave nothing behind.
//
// An EMPTY seal (nothing collected, or nothing the index took) is refused, not
// sealed: a commit of nothing would claim a failing test exists when none was
// written — the exact lie D13 exists to prevent — and `weeder bite` would check
// it out and find the state unchanged.
// The refusal is a `red` gate failure carrying the gate's own exit code, so the
// handleGate → settleRetryable ladder retries it in the same tree, restarting
// at the red phase with the evidence attached to its prompt.
async function sealRedPhase(
  node: Node,
  cwd: string,
  deps: ConductorDeps,
  result: WorkerResult,
  exitCode: number,
): Promise<void> {
  const files = await collectDelivery(deps, node, cwd, result);
  if (files.length === 0) throw new GateFailedError('red', EMPTY_RED_EVIDENCE, exitCode);
  const markers = await deps.isolate.scanMarkers(cwd);
  if (markers.length > 0) throw new GateFailedError('marker', markerEvidence(markers), SCAN_EXIT);
  await deps.isolate.stage(cwd, files);
  // A path the worker named but never changed stages nothing (D19): the index,
  // not the report, says whether this phase wrote anything to seal.
  const staged = await deps.isolate.stagedPaths(cwd);
  if (staged.length === 0) throw new GateFailedError('red', EMPTY_RED_EVIDENCE, exitCode);
  const hygiene = await scanHygiene(deps, node, cwd, files, result.finalMessage);
  if (hygiene !== null) {
    throw new GateFailedError(`hygiene:${hygiene.kind}`, hygiene.evidence, SCAN_EXIT);
  }
  const { sha } = await deps.isolate.commit(cwd, redPhaseMessage(node));
  await deps.journal.append({
    event: 'phase-commit',
    node: node.id,
    phase: 'red',
    sha,
    files: staged,
  });
}

// The command failing over a tree nothing wrote to is a harness fault — a
// missing runner, a wrong path, an ENOENT — and reads identically to a real red
// from the exit code alone. Name that for the worker; the retry restarts at red.
const EMPTY_RED_EVIDENCE =
  'The red phase changed no file: the test command failed over a tree nothing was written to. ' +
  'A failing command with no test written is a harness error (missing runner, wrong path, ' +
  'command not found), not a red — write the failing test, then let the gate run it.';

// Subject names the node and the phase; the body names the command that went
// red; the trailer is what `weeder bite` reads to find the state to check out.
function redPhaseMessage(node: Node): string {
  const test = 'test' in node.work ? node.work.test : '';
  return `pleach: ${node.id} red phase\n\ntest: ${test}\n\npleach-phase: red`;
}

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
    { gate: { ran: gateRanLabel(node, err.gate), exitCode: err.exitCode } },
    err.evidence,
  );
  if (settle) return { settle };
  return { evidence: gateEvidence(err.gate, err.exitCode, err.evidence) };
}

// The label recorded in evidence.gate.ran. For command/red/green/setup the
// concrete command string is most useful; fall back to the gate kind.
function gateRanLabel(node: Node, gate: GateKind): string {
  switch (gate) {
    case 'command':
      return 'command' in node.work ? node.work.command : 'command';
    case 'red':
    case 'green':
      return 'test' in node.work ? node.work.test : gate;
    case 'smoke':
      return node.accept.smoke ?? 'smoke';
    case 'setup':
      return node.setup ?? 'setup';
    default:
      return gate;
  }
}

// A gate that never ran (D19) settles on the attempt that found it: no retry
// changes the command the guard refused or the binary the environment lacks,
// and re-prompting a worker spends its window on a fault it cannot touch. The
// tree goes back for quarantine like any failed node's; `detail` says whose
// fault it is, with what the guard or the exec seam said about it.
function settleCannotRun(
  node: Node,
  attempts: number,
  ran: string,
  exitCode: number,
  fault: GateFault,
  output: string,
): RunNodeResult {
  const tail = outputTail(output);
  return {
    verdict: failedVerdict(node, attempts, { gate: { ran, exitCode } }),
    verdictDetail: `${CANNOT_RUN[fault]}: ${tail}`,
    gateOutputTail: tail,
  };
}

const CANNOT_RUN: Record<GateFault, string> = {
  plan: "the plan's gate cannot run; fix the plan, no attempt can",
  environment: 'the environment cannot run the gate; fix the environment, no attempt can',
};

// Settle a retryable failure into a failed Verdict iff attempts are exhausted;
// otherwise return undefined (caller continues the loop).
function settleRetryable(
  node: Node,
  attempts: number,
  maxAttempts: number,
  extra: { gate?: { ran: string; exitCode: number } },
  output?: string,
): RunNodeResult | undefined {
  if (attempts < maxAttempts) return undefined;
  return {
    verdict: failedVerdict(node, attempts, extra),
    // A red with NO output records an explicit marker (D10) — the absence of
    // evidence is itself diagnostic (died before printing, killed, ENOENT),
    // never a silent hole the operator debugs blind.
    ...(output !== undefined ? { gateOutputTail: outputTail(output) } : {}),
  };
}

const EVIDENCE_TAIL = 2000;
const NO_OUTPUT_MARKER =
  '(gate produced no output — the command died before printing, was killed, or never spawned)';

// A gate's output, capped from the end; no output is named, never left blank.
// Exported for run-plan: the verified commit is settle's gate (D21).
export function outputTail(output: string): string {
  return output.length === 0 ? NO_OUTPUT_MARKER : output.slice(-EVIDENCE_TAIL);
}

const BLOCKED_REASON_CAP = 4000;
const EMPTY_BLOCKED_MARKER = '(BLOCKED.md is empty — the worker wrote no explanation)';

// BLOCKED.md's text as the verdict's reason (D21). Unlike a gate log, it is
// prose read from the top, so the opening is kept; an empty file is named,
// never left blank.
function blockedReasonOf(text: string): string {
  return text.trim().length === 0 ? EMPTY_BLOCKED_MARKER : text.slice(0, BLOCKED_REASON_CAP);
}

function gateEvidence(gate: string, exitCode: number, output: string): string {
  return `Gate '${gate}' failed (exit ${exitCode}). Output tail:\n${outputTail(output)}`;
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

// What the tree already holds, for the worker that just landed in it (D17).
// The work is a worker's own, interrupted before any gate ran over it, and the
// next one is about to continue inside it — so it is told where the tree came
// from and what is in it. A quarantine the seam could show no stat for says
// only where it came from; nothing here is invented.
function resumeEvidence(resumed: ResumedFrom | undefined): string | undefined {
  if (resumed === undefined) return undefined;
  const from = `resuming work interrupted at ${resumed.sha}`;
  return resumed.stat === undefined ? from : `${from}:\n${resumed.stat}`;
}

// Why an attempt was left unspent when the run named no second cast (D17).
const NO_FALLBACK =
  'no fallback provider; the second attempt would have spent the same dead provider';

// The audit diversity rule (binding prose), against the provider that will
// actually build: an auditor may never be the builder. Checked before the first
// spawn and again before a fallback re-cast — the rule is about who ran, not
// about what the plan said. Returns the refusal, or undefined when it holds.
function auditDiversityRefusal(node: Node, provider: string): string | undefined {
  if (!node.accept.audit || node.accept.audit.provider !== provider) return undefined;
  return `node '${node.id}': resolved audit provider '${node.accept.audit.provider}' must differ from build provider '${provider}'`;
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
