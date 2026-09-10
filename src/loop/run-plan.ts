import { GateFailedError, QuarantineBusyError, RebuildRequiredError } from '../core/errors.ts';
import type { Node, Plan, Verdict } from '../core/plan.ts';
import {
  computeDegraded,
  type GateRecord,
  type MintFacts,
  mintReceipt,
  type Receipt,
  sha256Hex,
} from '../core/receipt.ts';
import { DEFAULT_WORKER_PROVIDER, validatePlan } from '../core/validate.ts';
import type { ArtifactKind, ConductorDeps, Isolation, RunSummary } from './deps.ts';
import { type ResumedFrom, type RunNodeResult, runNode } from './run-node.ts';

// ── run-plan: the scheduler ──────────────────────────────────────────────────
//
// Drives a validated Plan to a RunSummary. Owns the lock, the closed-set, the
// ready/inflight scheduler with a concurrency semaphore, and the per-node
// commit-before-emit + dual-close decision. Composes injected seams only.
//
// Concurrency model (the v0.3 shape): ready() = pending nodes whose needs are
// all closed and that aren't failed/partial/blocked/aborted/inflight; launch up to a semaphore
// cap; Promise.race the inflight set; node promises NEVER reject (.catch maps a
// surprise to a failed verdict). The closed-then-dispose ordering happens
// inside each node's inflight promise so a dependent can never isolate against
// a still-live worktree (ENGINEERING.md concurrency invariants).

export interface RunPlanOpts {
  repoRoot: string;
  maxConcurrency?: number;
  // The conductor's fallback when neither the flag nor the plan caps
  // concurrency. The CONTRACT says cores−2 (plan-schema.md) — the face computes
  // that (the loop stays environment-free) and passes it here.
  defaultConcurrency?: number;
  defaultTimeoutMs?: number;
  // Stamped into receipt facts (§D version fence). The face passes the real
  // package version; absent (tests, embedders) records an honest dev marker.
  pleachVersion?: string;
  // Teardown signal (D12): stop launching, interrupt in-flight waits, settle
  // what's live (workers killed, trees quarantined/disposed), journal why.
  signal?: AbortSignal;
  // The conductor's idle timeout (D16), handed to every worker wait in the
  // run. The face owns the default; a runner that cannot detect idleness
  // ignores it. Absent leaves the attempt clock as the only bound.
  idleMs?: number;
  // The run's second cast (D17): the provider a `dead` attempt is re-cast on,
  // audit diversity re-checked against it. Absent, a dead attempt settles the
  // node rather than spending another attempt on the same outage.
  fallbackProvider?: string;
  // `--fresh` (D17): ignore `quarantine/<id>` and isolate every pending node
  // from its dependencies alone. The default is to resume — a tree an earlier
  // attempt left behind is work, and rebuilding from nothing throws it away.
  fresh?: boolean;
}

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes (binding prose).
const FALLBACK_CONCURRENCY = 1; // conservative when no cap is supplied.
const ROOT_BASE_REF = 'HEAD'; // a node with no needs isolates from repo HEAD.

export async function runPlan(
  plan: Plan,
  deps: ConductorDeps,
  opts: RunPlanOpts,
): Promise<RunSummary> {
  validatePlan(plan); // throws PlanInvalidError — the face maps exit 2.

  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxConcurrency = Math.max(
    1,
    opts.maxConcurrency ?? plan.maxConcurrency ?? opts.defaultConcurrency ?? FALLBACK_CONCURRENCY,
  );

  const lock = await deps.lock.acquire(opts.repoRoot, plan.source);
  try {
    return await runUnderLock(plan, deps, {
      repoRoot: opts.repoRoot,
      defaultTimeoutMs,
      maxConcurrency,
      pleachVersion: opts.pleachVersion ?? '0.0.0-dev',
      fresh: opts.fresh === true,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
      ...(opts.fallbackProvider !== undefined ? { fallbackProvider: opts.fallbackProvider } : {}),
    });
  } finally {
    await lock.release();
  }
}

interface ResolvedOpts {
  repoRoot: string;
  defaultTimeoutMs: number;
  maxConcurrency: number;
  pleachVersion: string;
  fresh: boolean;
  signal?: AbortSignal;
  idleMs?: number;
  fallbackProvider?: string;
}

async function runUnderLock(
  plan: Plan,
  deps: ConductorDeps,
  opts: ResolvedOpts,
): Promise<RunSummary> {
  await deps.journal.append({ event: 'run-start', goal: plan.goal, nodes: plan.nodes.length });

  // Defensive copy (M3) — never mutate what the seam returned.
  const closed = new Map<string, string | null>(await deps.ledger.readClosed(plan.source));

  // §D acceptance-evolution invalidation: a close was verified against the
  // acceptance recorded in its receipt. If the plan's CURRENT acceptance
  // differs (generic string compare — no pin semantics parsed), the old
  // verification proves nothing about the new fitness function: re-dispatch
  // instead of skip-trusting. No receipt (legacy close, tend-verified lane)
  // → no comparison; the skip stands.
  const invalidated = new Set<string>();
  for (const node of plan.nodes) {
    if (!closed.has(node.id)) continue;
    const receipt = await deps.receipts.read(node.id);
    if (receipt === null || receipt.facts.source !== plan.source) continue;
    const current = acceptanceOf(node);
    const recorded = receipt.facts.acceptance;
    if (recorded.smoke !== current.smoke || recorded.audit !== current.audit) {
      closed.delete(node.id);
      invalidated.add(node.id);
      await deps.journal.append({
        event: 'acceptance-changed',
        node: node.id,
        recorded,
        current,
      });
    }
  }
  // Cascade: a closed dependent's verification embedded the OLD ancestor —
  // skip-trusting it would land stale work (only sinks land, so the
  // re-verified ancestor would silently never reach the target branch).
  for (let changed = invalidated.size > 0; changed; ) {
    changed = false;
    for (const node of plan.nodes) {
      if (!closed.has(node.id)) continue;
      const via = node.needs.find((d) => invalidated.has(d));
      if (via === undefined) continue;
      closed.delete(node.id);
      invalidated.add(node.id);
      changed = true;
      await deps.journal.append({ event: 'acceptance-cascade', node: node.id, via });
    }
  }

  // Nodes the ledger already had verified — skipped this run, surfaced so the
  // caller knows a resume happened. Captured BEFORE seedClosure adds ancestors,
  // so it names only what the ledger directly reported (not implied ancestors).
  const alreadyVerified = plan.nodes.filter((n) => closed.has(n.id)).map((n) => n.id);
  seedClosure(plan, closed);

  // Startup reconciliation (B1/B2): every closed id a pending node depends on
  // must resolve to a commit NOW, else halt honestly (v1 has no auto-rebuild).
  // The resolved baseRef per closed id is reused as the dependent's isolate base.
  const baseRefForClosed = new Map<string, string>();
  for (const node of plan.nodes) {
    if (closed.has(node.id)) continue; // already closed — not pending
    for (const dep of node.needs) {
      if (!closed.has(dep)) continue;
      if (baseRefForClosed.has(dep)) continue;
      const resolved = await resolveBaseRef(deps, opts.repoRoot, dep, closed.get(dep) ?? null);
      if (resolved === null) {
        await deps.journal.append({ event: 'rebuild-required', node: dep });
        throw new RebuildRequiredError(dep);
      }
      baseRefForClosed.set(dep, resolved);
    }
  }

  const failed = new Set<string>();
  const blocked = new Set<string>();
  // Nodes the run's own signal cut off mid-wait (D16) — settled, not failed.
  const aborted = new Set<string>();
  // Audit nodes that reached a 'done' verdict (work committed, gates green) but
  // tend declined to verify-close — published, unverified, terminal (never re-run).
  const partial = new Set<string>();
  // Failed nodes whose evidence was preserved on quarantine/<id> before dispose.
  const quarantined = new Set<string>();
  const inflight = new Map<string, Promise<void>>();

  // A node is schedulable when pending, not yet failed/blocked/aborted/partial/
  // inflight, and all its needs are closed.
  function ready(): Node[] {
    const out: Node[] = [];
    for (const node of plan.nodes) {
      if (
        closed.has(node.id) ||
        failed.has(node.id) ||
        blocked.has(node.id) ||
        aborted.has(node.id) ||
        partial.has(node.id)
      )
        continue;
      if (inflight.has(node.id)) continue;
      if (node.needs.every((d) => closed.has(d))) out.push(node);
    }
    return out;
  }

  // The tree an earlier attempt left behind, when this node has one to stand on
  // (D17). A pending node is unverified by definition, so its `quarantine/<id>`
  // — if it still resolves — is its own interrupted work, and rebuilding from
  // nothing throws that away. What is IN the tree is trusted by nobody: it was
  // never gated, so the whole ladder runs over it below. Only its provenance is
  // recorded — in the journal for the operator, and in the close's sealed facts
  // so a resumed close stays distinguishable from a fresh one forever.
  // `--fresh` refuses the seed.
  async function resumeFrom(node: Node): Promise<ResumedFrom | undefined> {
    if (opts.fresh) return undefined;
    const sha = await deps.isolate.refSha(opts.repoRoot, `quarantine/${node.id}`);
    if (sha === null) return undefined;
    // Which tree, though, is a question the gates cannot answer. The branch
    // outlives the close that wrote it: a node that failed, then closed
    // verified on a later run, still has the failed tree sitting on
    // `quarantine/<id>`, and standing on THAT would resurrect work its own
    // verified close already replaced. So the node's latest receipt has to
    // name this very tree — the same rule `pleach audit` applies before it
    // re-adjudicates one. A close that published instead, or kept a different
    // tree, refuses the seed; a node with no receipt at all keeps it, the
    // quarantine being then the only account of the work there is.
    const receipt = await deps.receipts.read(node.id);
    if (receipt !== null && receipt.refs?.quarantineSha !== sha) {
      await deps.journal.append({
        event: 'resume-refused',
        node: node.id,
        sha,
        detail: "the node's latest close kept a different tree — the quarantine is superseded",
      });
      return undefined;
    }
    // How far through a phased list that tree got (D13), from the same receipt
    // that vouched for it. What a quarantine HOLDS is trusted by no gate, but
    // where the phase ladder left off is not a claim about the work — it is
    // what the tree is, and an attempt re-entering at a phase the tree already
    // sealed can only remake that seal as a lie or over nothing.
    const redSealedAt = receipt?.facts.redSealedAt;
    // The index belongs to the list the PLAN carries now, and a plan is edited
    // between runs. If it no longer names a red phase, the seal it recorded is
    // not this list's, and re-entering after it would skip a phase that never
    // ran — a verified close over a cycle that did not happen. Refuse the seed:
    // the tree stays where it is, and the node builds its own.
    if (redSealedAt !== undefined && !sealsRed(node, redSealedAt)) {
      await deps.journal.append({
        event: 'resume-refused',
        node: node.id,
        sha,
        detail: `the plan's phase ${redSealedAt} is no longer the red the tree sealed — the work list moved`,
      });
      return undefined;
    }
    const stat = await deps.isolate.commitStat(opts.repoRoot, sha);
    await deps.journal.append({ event: 'resumed-from-quarantine', node: node.id, sha });
    return {
      sha,
      ...(stat !== null ? { stat } : {}),
      ...(redSealedAt !== undefined ? { redSealedAt } : {}),
    };
  }

  // Run one node to its terminal effect on closed/failed/partial/blocked/aborted.
  // Never rejects.
  async function runOne(node: Node): Promise<void> {
    const resumed = await resumeFrom(node);
    const baseRefs = baseRefsFor(node, baseRefForClosed, resumed?.sha);
    await deps.journal.append({ event: 'node-start', node: node.id });
    const startedAt = Date.now();

    // Whether the cast ever ran this node's work, on any attempt (D19). It
    // rides every verdict line beside `provider`, which names the cast either
    // way — a {command} node's cast never runs, and neither does a node that
    // settles before its first spawn.
    let spawned = false;
    let outcome: RunNodeResult;
    try {
      outcome = await runNode(node, baseRefs, deps, {
        defaultTimeoutMs: opts.defaultTimeoutMs,
        signal: opts.signal,
        idleMs: opts.idleMs,
        fallbackProvider: opts.fallbackProvider,
        resumedFrom: resumed,
        onSpawn: () => {
          spawned = true;
        },
      });
    } catch (err) {
      // A node promise must never reject — map a surprise to a failed verdict.
      // The casting join (G1) does not depend on how the verdict was reached:
      // who was cast is known from the plan before anything ran, so a surprise
      // says it too — `provider` is resolved and never absent on a verdict.
      await deps.journal.append({
        event: 'verdict',
        node: node.id,
        status: 'failed',
        detail: err instanceof Error ? err.message : String(err),
        provider: node.worker.provider ?? DEFAULT_WORKER_PROVIDER,
        ...(node.worker.model !== undefined ? { model: node.worker.model } : {}),
        spawned,
      });
      failed.add(node.id);
      return;
    }

    await settle(node, outcome, startedAt, resumed, spawned);
  }

  // A gate's findings log and the tree's own friction journal (D14), and the
  // message the work handed back (D17), all outlive the tree. Each is kept
  // beside the receipt BEFORE dispose: keeping is part of settling a live
  // tree, not of the bookkeeping after it, so nothing that has to be read from
  // the worktree can be lost to ordering, and nothing is kept for a session
  // that has already been killed.
  // Returns what the receipt file should name, outside its envelope; a gate
  // that printed something else, a tree with no journal in it, and a worker
  // that said nothing keep nothing. A write failure journals `receipt-write-failed` and the close
  // proceeds, exactly like the receipt file's own write: the seal is already
  // pinned in the commit trailer.
  async function keepArtifactsOrJournal(
    node: Node,
    iso: Isolation | undefined,
    outcome: RunNodeResult,
    receipt: Receipt,
  ): Promise<Receipt['artifacts']> {
    // The gate's own findings log: kept only when the gate sealed a hash for
    // it, and hashed by nobody here — one sha256, minted with the facts and
    // answered by the file.
    const sealed = receipt.facts.gates.find((g) => g.gate === 'smoke')?.artifactSha;
    const stdout = outcome.smokeStdout;
    const sarif = await keepOrJournal(node, 'smoke', 'sarif', receipt.sha256, async () =>
      stdout === undefined || sealed === undefined ? null : { bytes: stdout, sha256: sealed },
    );
    // The tree's own record (D14): no gate produced it, so nothing sealed it —
    // it is read here, the last moment the worktree exists, and hashed over
    // the bytes kept. Collection has already set the directory aside, so what
    // is kept is exactly what no commit carries.
    const friction = await keepOrJournal(node, 'friction', 'friction', receipt.sha256, async () => {
      const text = iso === undefined ? null : await deps.isolate.readFriction(iso.cwd);
      return text === null ? null : { bytes: text, sha256: sha256Hex(text) };
    });
    // What the worker said when it handed the work back (D17) — the message
    // whose dated Tried line the garden's law asks for, which until now
    // survived only in the provider's own transcript. Kept verbatim and read
    // by nobody: agents produce, code decides. A worker that said nothing
    // hands back nothing to keep.
    const handback = await keepOrJournal(node, 'handback', 'handback', receipt.sha256, async () => {
      const text = outcome.handback;
      return text === undefined || text === '' ? null : { bytes: text, sha256: sha256Hex(text) };
    });
    if (sarif === undefined && friction === undefined && handback === undefined) return undefined;
    return {
      ...(sarif !== undefined ? { sarif } : {}),
      ...(friction !== undefined ? { friction } : {}),
      ...(handback !== undefined ? { handback } : {}),
    };
  }

  // One artifact, kept or accounted for: nothing to keep returns undefined
  // quietly, and a read or write that fails is a journal line, never a failed
  // close — nor a reason to lose the other artifact.
  async function keepOrJournal(
    node: Node,
    gate: 'smoke' | 'friction' | 'handback',
    kind: ArtifactKind,
    receiptSha256: string,
    read: () => Promise<{ bytes: string; sha256: string } | null>,
  ): Promise<string | undefined> {
    try {
      const artifact = await read();
      // Nothing to keep, so nothing of this kind may sit beside the receipt
      // as the node's latest. A node closes more than once — §D acceptance
      // evolution re-dispatches one whose gate changed, which is exactly when
      // a gate that printed a findings log is replaced by one that prints none.
      // Left alone, the earlier close's log would be read as this close's by
      // whoever counts its findings. It keeps its own name (D17); what it
      // loses is the claim to be current.
      if (artifact === null) {
        await deps.receipts.discardArtifact(node.id, kind, receiptSha256);
        return undefined;
      }
      const path = await deps.receipts.writeArtifact(node.id, kind, artifact.bytes, receiptSha256);
      await deps.journal.append({
        event: 'gate-artifact',
        node: node.id,
        gate,
        path,
        sha256: artifact.sha256,
      });
      return path;
    } catch (err) {
      await deps.journal.append({
        event: 'receipt-write-failed',
        node: node.id,
        detail: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  // Commit-before-emit + dual-close, then dispose — all inside this promise so
  // the closed.set happens-before dispose, and dispose happens-before any
  // dependent's isolate (the scheduler only schedules dependents after closed).
  async function settle(
    node: Node,
    outcome: RunNodeResult,
    startedAt: number,
    resumed: ResumedFrom | undefined,
    spawned: boolean,
  ): Promise<void> {
    const { verdict, iso } = outcome;
    const durationMs = Date.now() - startedAt;
    // Record the full diagnostic shape — a failed run must be explainable from
    // the journal alone (the worktrees and sessions are gone by then).
    await deps.journal.append({
      event: 'verdict',
      node: node.id,
      status: verdict.status,
      attempts: verdict.attempts,
      // The cost feed (#18): worker-reported telemetry + wall clock, so the
      // casting ledger can compute cost-per-verified-claim from the journal
      // alone. Journal-only enrichment — the Verdict contract is untouched.
      telemetry: verdict.telemetry,
      durationMs,
      // The casting join (G1): who did this work, resolved — 'counted, never
      // attributed' was tend2's ledger's first finding; this closes it.
      provider: node.worker.provider ?? DEFAULT_WORKER_PROVIDER,
      ...(node.worker.model !== undefined ? { model: node.worker.model } : {}),
      spawned,
      ...(verdict.evidence.gate
        ? {
            gate: {
              ...verdict.evidence.gate,
              // Journal-only diagnostics (contract untouched): the failing
              // gate's actual output, so nobody debugs a red gate blind.
              ...(outcome.gateOutputTail !== undefined
                ? { outputTail: outcome.gateOutputTail }
                : {}),
            },
          }
        : {}),
      ...(verdict.evidence.blockedReason ? { blockedReason: verdict.evidence.blockedReason } : {}),
      // Why the node settled where it did when no gate says it (D17) — an
      // attempt left unspent on a dead provider, a fallback refused. The
      // operator reads the journal, not the source.
      ...(outcome.verdictDetail !== undefined ? { detail: outcome.verdictDetail } : {}),
      // What the runner saw at an abnormal end (D11) — capped, never fabricated.
      ...(outcome.runnerDetail?.paneTail !== undefined
        ? { paneTail: outcome.runnerDetail.paneTail.slice(-2000) }
        : {}),
      ...(outcome.runnerDetail?.processExit !== undefined
        ? { processExit: outcome.runnerDetail.processExit }
        : {}),
    });

    if (verdict.status !== 'done' || iso === undefined) {
      // blocked / failed / dead / timeout — emit for the record; no node/<id>
      // publish. No terminal verdict without an artifact (D11): the receipt
      // ALWAYS writes; quarantine refs attach only when a commit landed.
      // Blocked quarantines like failed — unfinished is not wrong.
      if (verdict.status === 'blocked') {
        blocked.add(node.id);
        await deps.journal.append({
          event: 'blocked',
          node: node.id,
          reason: verdict.evidence.blockedReason,
        });
      } else if (verdict.status === 'aborted') {
        // The run stopped holding this node; it did not lose (D16). Everything
        // below is the settle every terminal verdict gets — receipt, quarantine,
        // dispose — so the work survives the halt.
        aborted.add(node.id);
      } else {
        failed.add(node.id);
      }
      await deps.ledger.emitVerdict(verdict, plan.source);
      const receipt = mintReceipt(
        buildFacts(plan, node, outcome, durationMs, opts.pleachVersion, resumed),
      );
      // A failed strict gate wrote the log that says why — exactly the log the
      // calibration folds want, so the quarantine path keeps it too.
      const artifacts = await keepArtifactsOrJournal(node, iso, outcome, receipt);
      let refs: Receipt['refs'];
      if (iso) {
        refs = await quarantineTree(deps, plan, node, iso, receipt);
        if (refs !== undefined) quarantined.add(node.id);
        await disposeOrJournal(deps, iso, node.id);
      }
      await writeReceiptOrJournal(deps, node.id, {
        ...receipt,
        ...(refs !== undefined ? { refs } : {}),
        ...(artifacts !== undefined ? { artifacts } : {}),
      });
      return;
    }

    // ── done: commit-before-emit, dispose-before-visibility ─────────────────
    // The worktree work (markers, commit, emit) happens first; then the tree is
    // FULLY disposed; only then do closed/failed mutate. A dependent woken by
    // another node's resolution can therefore never see this node as closed
    // while its worktree still exists (ordering invariant under concurrency).
    let sha: string | undefined;
    let decision: { closed: boolean } | undefined;
    let receipt: Receipt | undefined;
    let failure: unknown;
    try {
      // Pre-commit marker safety — the auditor shares the cwd and may have
      // written markers after the in-node gate. A dirty tree FAILS, no commit.
      const lateMarkers = await deps.isolate.scanMarkers(iso.cwd);
      if (lateMarkers.length > 0) {
        throw new GateFailedError('marker', lateMarkers.join('\n'), -1); // N/A: marker scan has no exit code
      }

      // Freeze point (§D): facts seal BEFORE the commit exists, so the commit
      // SHA never lives inside the hashed envelope — the trailer rides in the
      // commit whose SHA is the diffRef, and git binds them.
      receipt = mintReceipt(
        buildFacts(plan, node, outcome, durationMs, opts.pleachVersion, resumed),
      );
      const { sha: committed } = await deps.isolate.commitBranch(
        iso.cwd,
        `node/${node.id}`,
        `${commitMessage(plan, node, verdict)}\n\nreceipt-sha256: ${receipt.sha256}`,
      );
      sha = committed;
      const closingVerdict: Verdict = {
        ...verdict,
        evidence: { ...verdict.evidence, diffRef: committed },
      };

      // A1 dual close: audit nodes defer to tend; non-audit nodes the conductor
      // closes itself (tend has nothing to decide). Both commit first (B2).
      decision = await deps.ledger.emitVerdict(closingVerdict, plan.source);
    } catch (err) {
      failure = err;
    }

    // Before the tree goes. A close that never committed writes no receipt, so
    // it keeps nothing either — there would be no receipt to name the file.
    const artifacts =
      receipt !== undefined && failure === undefined
        ? await keepArtifactsOrJournal(node, iso, outcome, receipt)
        : undefined;

    await disposeOrJournal(deps, iso, node.id);

    if (failure !== undefined || sha === undefined || decision === undefined) {
      const err = failure;
      failed.add(node.id);
      const failVerdict: Verdict = {
        ...verdict,
        status: 'failed',
        evidence:
          err instanceof GateFailedError
            ? { ...verdict.evidence, gate: { ran: err.gate, exitCode: err.exitCode } }
            : verdict.evidence,
      };
      await deps.journal.append({
        event: 'gate-fail',
        node: node.id,
        gate: err instanceof GateFailedError ? err.gate : 'commit',
      });
      await deps.ledger.emitVerdict(failVerdict, plan.source);
      return;
    }

    // The receipt file is written whenever the mint's trailer reached a
    // published commit — even when tend declines the close (partial), the
    // pinned hash must stay resolvable to its facts.
    if (receipt !== undefined) {
      await writeReceiptOrJournal(deps, node.id, {
        ...receipt,
        refs: { diffRef: sha },
        ...(artifacts !== undefined ? { artifacts } : {}),
      });
    }

    const shouldClose = node.accept.audit ? decision.closed : true;
    if (shouldClose) {
      closed.set(node.id, sha);
      baseRefForClosed.set(node.id, sha); // pin to the immutable commit SHA, not the movable branch
      // degraded[] rides the close event — trust decisions happen at close
      // time, not at receipt-inspection time (§D amendment).
      await deps.journal.append({
        event: 'closed',
        node: node.id,
        sha,
        ...(receipt !== undefined && receipt.facts.degraded.length > 0
          ? { degraded: receipt.facts.degraded }
          : {}),
      });
    } else {
      // tend declined to verify-close this audit node: the branch IS published
      // (node/<id> committed, every conductor gate green) but tend won't flip the
      // feature to verified. That's 'partial', not 'failed' — nothing broke, it's
      // just unverified. Dependents stay skipped (they can't build on an unverified
      // base); a caller must not retry it as a failure.
      partial.add(node.id);
      await deps.journal.append({ event: 'not-closed', node: node.id });
    }
  }

  // ── scheduler loop ──────────────────────────────────────────────────────────
  for (;;) {
    // An abort stops NEW launches; in-flight nodes settle (their waits are
    // interrupted by the same signal) so evidence and teardown still happen.
    while (inflight.size < opts.maxConcurrency && opts.signal?.aborted !== true) {
      const next = ready().find((n) => !inflight.has(n.id));
      if (!next) break;
      // The drain (D16) is decided HERE, in the same tick as the close that
      // made this node ready — read fresh per launch, never cached at the top
      // of the run, because that tick is exactly where an operator's `pleach
      // stop` used to lose the race and spawn a worker only to kill it (#67).
      // It gates the launch and nothing else: what is already in flight is
      // carried to its own close.
      if (await deps.lock.stopRequested(opts.repoRoot, plan.source)) break;
      const promise = runOne(next).finally(() => inflight.delete(next.id));
      inflight.set(next.id, promise);
    }
    if (inflight.size === 0) break;
    await Promise.race(inflight.values());
  }
  if (opts.signal?.aborted === true) {
    await deps.journal.append({ event: 'run-aborted' });
  }
  // One authoritative read at the end, so a stop that landed after the last
  // launch decision — with nothing left to gate — is still recorded and still
  // consumed. An unconsumed marker would drain the NEXT run before it started.
  if (await deps.lock.stopRequested(opts.repoRoot, plan.source)) {
    await deps.journal.append({ event: 'run-stopped' });
    await deps.lock.clearStop(opts.repoRoot, plan.source);
  }

  const skipped = plan.nodes
    .filter(
      (n) =>
        !closed.has(n.id) &&
        !failed.has(n.id) &&
        !blocked.has(n.id) &&
        !aborted.has(n.id) &&
        !partial.has(n.id),
    )
    .map((n) => n.id);

  const alreadyVerifiedSet = new Set(alreadyVerified);
  const summary: RunSummary = {
    closed: plan.nodes
      .filter((n) => closed.has(n.id) && !alreadyVerifiedSet.has(n.id))
      .map((n) => n.id),
    failed: [...failed],
    partial: [...partial],
    skipped,
    blocked: [...blocked],
    aborted: [...aborted],
    quarantined: [...quarantined],
    alreadyVerified,
  };
  await deps.journal.append({ event: 'run-end', ...summary });
  return summary;
}

// ── helpers ──────────────────────────────────────────────────────────────────
//
// Settling a node — its record, its evidence, its tree — is the same work
// wherever the verdict came from, so run-plan's scheduler and `pleach audit`'s
// re-adjudication (D17) share these three rather than each keeping a copy of
// the rules about what may never fail a close.

// A receipt-file write failure must never fail a settled node — the trailer is
// already pinned in git; journal the miss and continue. A node that closes
// again keeps both records (D17): the store files every close under its own
// hash, and the new one points back at the receipt it replaced as the latest.
export async function writeReceiptOrJournal(
  deps: ConductorDeps,
  nodeId: string,
  incoming: Receipt,
): Promise<void> {
  try {
    const prior = await deps.receipts.read(nodeId);
    const receipt: Receipt =
      prior !== null && prior.sha256 !== incoming.sha256
        ? { ...incoming, refs: { ...incoming.refs, previousReceiptSha256: prior.sha256 } }
        : incoming;
    await deps.receipts.write(nodeId, receipt);
    await deps.journal.append({
      event: 'receipt',
      node: nodeId,
      sha256: receipt.sha256,
      derived: receipt.derived,
      degraded: receipt.facts.degraded,
    });
  } catch (err) {
    await deps.journal.append({
      event: 'receipt-write-failed',
      node: nodeId,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

// Failed work is evidence, not garbage: commit the tree's changes to
// quarantine/<id> — never node/<id>, nothing was verified — so the operator can
// inspect what the agent actually wrote instead of debugging from a 2000-char
// output tail. Best-effort: a quarantine failure journals and never masks the
// real verdict. An unchanged tree quarantines nothing, unless the caller says
// otherwise: a re-adjudication (D17) judges a tree it did not write, and its
// refusal is a fact about that tree that must reach a commit of its own — no
// terminal verdict without an artifact (D11). Returns the quarantine refs when
// a commit landed, undefined otherwise — the caller writes the receipt either way.
export async function quarantineTree(
  deps: ConductorDeps,
  plan: Plan,
  node: Node,
  iso: Isolation,
  receipt: Receipt,
  opts: { allowEmpty?: boolean } = {},
): Promise<Receipt['refs']> {
  try {
    const changed = await deps.isolate.changedFiles(iso.cwd);
    if (changed.length === 0 && opts.allowEmpty !== true) return undefined;
    if (changed.length > 0) await deps.isolate.stage(iso.cwd, changed);
    // #12: the quarantine branch may be checked out in a human's worktree
    // (the owner inspecting the last failure). A busy-branch refusal falls
    // back to a suffixed ref — evidence must never evaporate over ref
    // hygiene. Other errors go to the honest quarantine-failed path.
    const base = `quarantine/${node.id}`;
    const message = `pleach: ${node.id} quarantined\n\nsource: ${plan.source}\ngoal: ${plan.goal}\n\nreceipt-sha256: ${receipt.sha256}`;
    let landedBranch: string | null = null;
    let sha = '';
    for (const branch of [base, `${base}.2`, `${base}.3`, `${base}.4`]) {
      try {
        ({ sha } = await deps.isolate.commitBranch(iso.cwd, branch, message));
        landedBranch = branch;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('used by worktree')) throw err;
      }
    }
    if (landedBranch === null) throw new QuarantineBusyError(base);
    await deps.journal.append({ event: 'quarantined', node: node.id, branch: landedBranch, sha });
    return { quarantineBranch: landedBranch, quarantineSha: sha };
  } catch (err) {
    await deps.journal.append({
      event: 'quarantine-failed',
      node: node.id,
      detail: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

// Node promises NEVER reject. A dispose() failure must not propagate — the work
// is already committed and the verdict emitted. Journal it and continue so the
// run summary reflects the correct closed/failed state.
export async function disposeOrJournal(
  deps: ConductorDeps,
  iso: Isolation,
  nodeId: string,
): Promise<void> {
  try {
    await iso.dispose();
  } catch (err) {
    await deps.journal.append({
      event: 'dispose-failed',
      node: nodeId,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

// Every transitive ancestor (via needs) of a closed node is also closed — a
// closed integration node contains its steps' work, so its steps need not run.
// Exported for loop/land.ts, which applies the same closure before landing.
export function seedClosure(plan: Plan, closed: Map<string, string | null>): void {
  const byId = new Map<string, Node>(plan.nodes.map((n) => [n.id, n]));
  const queue = [...closed.keys()];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const node = byId.get(id);
    if (!node) continue;
    for (const dep of node.needs) {
      if (!closed.has(dep)) {
        closed.set(dep, null); // seeded — contained in the descendant's commit
        queue.push(dep);
      }
    }
  }
}

// Resolve a closed id to a usable baseRef: node/<id> branch if present and
// matches the recorded SHA, else the recorded SHA if it resolves, else null
// (→ rebuild required). If the branch exists but points to a different SHA
// than what the conductor recorded, the ref was force-moved (worker attack or
// external push) — throw RebuildRequiredError immediately (C5 verify-before-use).
// Exported for loop/land.ts — landing resolves sinks through the same chain.
export async function resolveBaseRef(
  deps: ConductorDeps,
  repoRoot: string,
  id: string,
  recordedSha: string | null,
): Promise<string | null> {
  const branch = `node/${id}`;
  const branchSha = await deps.isolate.refSha(repoRoot, branch);
  if (branchSha !== null) {
    if (recordedSha !== null && branchSha !== recordedSha) {
      await deps.journal.append({
        event: 'sha-mismatch',
        node: id,
        recordedSha,
        foundSha: branchSha,
      });
      throw new RebuildRequiredError(id);
    }
    return branch;
  }
  if (recordedSha !== null && (await deps.isolate.refSha(repoRoot, recordedSha)) !== null) {
    return recordedSha;
  }
  return null;
}

// Does the node's work list still call phase `index` a red? The seal a close
// recorded is an index into the list that close ran; only the plan says what
// that index means now.
function sealsRed(node: Node, index: number): boolean {
  return 'phases' in node.work && node.work.phases[index]?.phase === 'red';
}

// A node's isolate base refs: baseRefs[0] is the checkout, the rest merge onto
// it. The resolved ref of each closed need, in order; a node with no needs
// isolates from repo HEAD. A resumed node (D17) checks out the quarantined tree
// instead and merges the same dependencies onto it — the tree already descends
// from HEAD, so there is nothing to put behind it.
function baseRefsFor(
  node: Node,
  baseRefForClosed: Map<string, string>,
  resumeSha?: string,
): string[] {
  const merged = node.needs.map((d) => baseRefForClosed.get(d) ?? `node/${d}`);
  if (resumeSha !== undefined) return [resumeSha, ...merged];
  return merged.length === 0 ? [ROOT_BASE_REF] : merged;
}

function commitMessage(plan: Plan, node: Node, verdict: Verdict): string {
  return `pleach: ${node.id} verified (${verdict.status})\n\nsource: ${plan.source}\ngoal: ${plan.goal}`;
}

// The journal keeps the failing gate's verbatim output tail; the sealed
// receipt keeps a hash pointer to it, attached to the last red gate record.
function gatesWithTailSha(outcome: RunNodeResult): GateRecord[] {
  const gates = outcome.gates ?? [];
  const tail = outcome.gateOutputTail;
  if (tail === undefined) return gates;
  const lastRed = [...gates].reverse().find((g) => g.exitCode !== 0);
  if (lastRed === undefined) return gates;
  return gates.map((g) => (g === lastRed ? { ...g, outputTailSha: sha256Hex(tail) } : g));
}

// The node's acceptance as command strings — the receipt's evolution-
// invalidation record (§D). Generic strings, no pin semantics parsed.
export function acceptanceOf(node: Node): { smoke?: string; audit?: string } {
  return {
    ...(node.accept.smoke !== undefined ? { smoke: node.accept.smoke } : {}),
    ...(node.accept.audit !== undefined ? { audit: node.accept.audit.command } : {}),
  };
}

// Receipt facts from what settle already holds — frozen at classify time.
function buildFacts(
  plan: Plan,
  node: Node,
  outcome: RunNodeResult,
  durationMs: number,
  pleachVersion: string,
  resumed: ResumedFrom | undefined,
): MintFacts {
  const { verdict } = outcome;
  return {
    node: node.id,
    source: plan.source,
    status: verdict.status,
    attempts: verdict.attempts,
    provider: node.worker.provider ?? DEFAULT_WORKER_PROVIDER,
    ...(node.worker.model !== undefined ? { model: node.worker.model } : {}),
    gates: gatesWithTailSha(outcome),
    ...(outcome.audit !== undefined ? { audit: outcome.audit } : {}),
    // What this close stood on when it did not build its own tree (D17) —
    // sealed inside the envelope, so a resumed close is distinguishable from a
    // fresh one for as long as the receipt exists.
    ...(resumed !== undefined ? { base: { kind: 'quarantine' as const, sha: resumed.sha } } : {}),
    // Where the phase ladder left off in the tree this close held (D13) — the
    // one thing a later attempt seeded from that tree needs from this one.
    ...(outcome.redSealedAt !== undefined ? { redSealedAt: outcome.redSealedAt } : {}),
    acceptance: acceptanceOf(node),
    degraded: computeDegraded(node),
    stagedFiles: outcome.stagedFiles?.length ?? 0,
    telemetry: verdict.telemetry,
    durationMs,
    pleachVersion,
  };
}
