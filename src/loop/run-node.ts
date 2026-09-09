import { auditGateTampering, buildAuditPrompt, extractAuditJson } from '../core/audit-egress.ts';
import { classify } from '../core/classify.ts';
import { partitionDelivery } from '../core/delivery.ts';
import {
  AuditParseError,
  GateFailedError,
  IsolateCatastrophicError,
  PlanInvalidError,
} from '../core/errors.ts';
import { checkDiffHygiene, type HygieneFailure } from '../core/hygiene.ts';
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
  // Teardown signal (D12) — interrupts worker waits; everything else settles.
  signal?: AbortSignal;
}

export interface RunNodeResult {
  verdict: Verdict;
  // The live isolation, handed to run-plan for the commit-then-dispose
  // (done) or quarantine-then-dispose (terminal failed/dead/blocked) sequence.
  // Blocked hands its tree back too (D11) — workers edit files mid-turn, so
  // an unfinished turn is unfinished work, not nothing. Absent only for
  // never-isolated failures.
  iso?: Isolation;
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

  // Every terminal verdict (failed/dead/blocked) hands the live tree back so
  // run-plan can quarantine the evidence before disposing — blocked included
  // since D11: workers edit files mid-turn, so an unfinished turn holds work.
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
  // The phase the CURRENT tree has sealed a red commit for (D13), if any. It
  // belongs to the tree, not to the node: a retry that reuses the tree re-enters
  // after that phase, and a re-isolated tree (dead+resume) has sealed nothing
  // and earns a fresh red.
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

  try {
    for (;;) {
      attempts += 1;
      gates = [];
      auditRecords = undefined;
      lastStaged = undefined;

      // ── isolate (or reuse the tree for a retryable retry) ───────────────────
      if (iso === null) {
        redSealedAt = undefined;
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
        const { output, exitCode } = await execGateWithRetry(deps, node.id, 'setup', node.setup, {
          cwd,
          timeoutMs,
        });
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
          signal: opts.signal,
          redSealedAt,
          sealRed: async (red, exitCode, phaseIndex) => {
            await sealRedPhase(node, cwd, deps, red, exitCode);
            redSealedAt = phaseIndex;
          },
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
        // What the runner saw at the abnormal end, when it could see anything
        // (D11) — rides every terminal hand-back below, never fabricated.
        const runnerDetail = {
          ...(result.paneTail !== undefined ? { paneTail: result.paneTail } : {}),
          ...(result.processExit !== undefined ? { processExit: result.processExit } : {}),
        };
        const detail = Object.keys(runnerDetail).length > 0 ? { runnerDetail } : {};
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
          if (node.policy.onDead === 'resume' && attempts < maxAttempts) {
            await disposeQuiet(iso);
            iso = null; // force re-isolate (fresh tree)
            evidence = undefined;
            continue;
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
            ...detail,
          });
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
          ...detail,
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
        evidence = markerEvidence(markers);
        continue;
      }

      // ── scoped staging (ledger C2 — nothing re-stages after this) ────────────
      const stagedFiles = await collectDelivery(deps, node, cwd, result);
      await deps.isolate.stage(cwd, stagedFiles);
      lastStaged = stagedFiles;

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
        const { output, exitCode } = await execGateWithRetry(
          deps,
          node.id,
          'smoke',
          node.accept.smoke,
          { cwd, timeoutMs },
        );
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

        const auditOutcome = await runAudit(node, cwd, deps, timeoutMs, opts.signal);
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
  signal?: AbortSignal,
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
      res = await worker.wait({ timeoutMs, signal });
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

// The exec gates (setup, smoke) get ONE gate-only retry in the same
// provisioned worktree before a red becomes worker evidence — the land gate's
// flaky-retry doctrine at node level (D10, decker wave 2): a worker prompted
// to fix a failure that wasn't its fault "fixes" something that isn't broken,
// and good work ages in quarantine. Deterministic scans (marker, hygiene)
// never flake and get no retry; the audit has its own reaudit budget.
async function execGateWithRetry(
  deps: ConductorDeps,
  nodeId: string,
  gate: 'setup' | 'smoke',
  command: string,
  opts: { cwd: string; timeoutMs: number },
): Promise<{ output: string; exitCode: number }> {
  const first = await guardedExec(deps.exec, command, opts);
  if (first.exitCode === 0) return first;
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
// An EMPTY file set is refused, not sealed: a commit of nothing would claim a
// failing test exists when none was written — the exact lie D13 exists to
// prevent — and `weeder bite` would check it out and find the state unchanged.
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
  const hygiene = await scanHygiene(deps, node, cwd, files, result.finalMessage);
  if (hygiene !== null) {
    throw new GateFailedError(`hygiene:${hygiene.kind}`, hygiene.evidence, SCAN_EXIT);
  }
  const { sha } = await deps.isolate.commit(cwd, redPhaseMessage(node));
  await deps.journal.append({ event: 'phase-commit', node: node.id, phase: 'red', sha, files });
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
    // A red with NO output records an explicit marker (D10) — the absence of
    // evidence is itself diagnostic (died before printing, killed, ENOENT),
    // never a silent hole the operator debugs blind.
    ...(outputTail !== undefined
      ? { gateOutputTail: outputTail.length > 0 ? outputTail.slice(-2000) : NO_OUTPUT_MARKER }
      : {}),
  };
}

const EVIDENCE_TAIL = 2000;
const NO_OUTPUT_MARKER =
  '(gate produced no output — the command died before printing, was killed, or never spawned)';

function gateEvidence(gate: string, exitCode: number, output: string): string {
  const tail =
    output.length === 0
      ? NO_OUTPUT_MARKER
      : output.length > EVIDENCE_TAIL
        ? output.slice(-EVIDENCE_TAIL)
        : output;
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
