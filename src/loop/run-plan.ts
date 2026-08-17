import { GateFailedError, RebuildRequiredError } from '../core/errors.ts';
import type { Node, Plan, Verdict } from '../core/plan.ts';
import { validatePlan } from '../core/validate.ts';
import type { ConductorDeps, Isolation, RunSummary } from './deps.ts';
import { type RunNodeResult, runNode } from './run-node.ts';

// ── run-plan: the scheduler ──────────────────────────────────────────────────
//
// Drives a validated Plan to a RunSummary. Owns the lock, the closed-set, the
// ready/inflight scheduler with a concurrency semaphore, and the per-node
// commit-before-emit + dual-close decision. Composes injected seams only.
//
// Concurrency model (the v0.3 shape): ready() = pending nodes whose needs are
// all closed and that aren't failed/partial/blocked/inflight; launch up to a semaphore
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
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes (binding prose).
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
    });
  } finally {
    await lock.release();
  }
}

interface ResolvedOpts {
  repoRoot: string;
  defaultTimeoutMs: number;
  maxConcurrency: number;
}

async function runUnderLock(
  plan: Plan,
  deps: ConductorDeps,
  opts: ResolvedOpts,
): Promise<RunSummary> {
  await deps.journal.append({ event: 'run-start', goal: plan.goal, nodes: plan.nodes.length });

  // Defensive copy (M3) — never mutate what the seam returned.
  const closed = new Map<string, string | null>(await deps.ledger.readClosed(plan.source));
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
  // Audit nodes that reached a 'done' verdict (work committed, gates green) but
  // tend declined to verify-close — published, unverified, terminal (never re-run).
  const partial = new Set<string>();
  // Failed nodes whose evidence was preserved on quarantine/<id> before dispose.
  const quarantined = new Set<string>();
  const inflight = new Map<string, Promise<void>>();

  // A node is schedulable when pending, not yet failed/blocked/partial/inflight,
  // and all its needs are closed.
  function ready(): Node[] {
    const out: Node[] = [];
    for (const node of plan.nodes) {
      if (
        closed.has(node.id) ||
        failed.has(node.id) ||
        blocked.has(node.id) ||
        partial.has(node.id)
      )
        continue;
      if (inflight.has(node.id)) continue;
      if (node.needs.every((d) => closed.has(d))) out.push(node);
    }
    return out;
  }

  // Run one node to its terminal effect on closed/failed/partial/blocked. Never rejects.
  async function runOne(node: Node): Promise<void> {
    const baseRefs = baseRefsFor(node, baseRefForClosed);
    await deps.journal.append({ event: 'node-start', node: node.id });
    const startedAt = Date.now();

    let outcome: RunNodeResult;
    try {
      outcome = await runNode(node, baseRefs, deps, { defaultTimeoutMs: opts.defaultTimeoutMs });
    } catch (err) {
      // A node promise must never reject — map a surprise to a failed verdict.
      await deps.journal.append({
        event: 'verdict',
        node: node.id,
        status: 'failed',
        detail: err instanceof Error ? err.message : String(err),
      });
      failed.add(node.id);
      return;
    }

    await settle(node, outcome, startedAt);
  }

  // Failed work is evidence, not garbage: commit the tree's changes to
  // quarantine/<id> — never node/<id>, nothing was verified — so the operator
  // can inspect what the agent actually wrote instead of debugging from a
  // 2000-char output tail. Best-effort: a quarantine failure journals and
  // never masks the real verdict. An unchanged tree quarantines nothing.
  async function quarantineOrJournal(node: Node, iso: Isolation): Promise<void> {
    try {
      const changed = await deps.isolate.changedFiles(iso.cwd);
      if (changed.length === 0) return;
      await deps.isolate.stage(iso.cwd, changed);
      // #12: the quarantine branch may be checked out in a human's worktree
      // (the owner inspecting the last failure). A busy-branch refusal falls
      // back to a suffixed ref — evidence must never evaporate over ref
      // hygiene. Other errors go to the honest quarantine-failed path.
      const base = `quarantine/${node.id}`;
      const message = `pleach: ${node.id} quarantined\n\nsource: ${plan.source}\ngoal: ${plan.goal}`;
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
      if (landedBranch === null) throw new Error(`all quarantine refs for ${base} are busy`);
      quarantined.add(node.id);
      await deps.journal.append({ event: 'quarantined', node: node.id, branch: landedBranch, sha });
    } catch (err) {
      await deps.journal.append({
        event: 'quarantine-failed',
        node: node.id,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Node promises NEVER reject (run-plan.ts:115). A dispose() failure must not
  // propagate — the work is already committed and the verdict emitted. Journal it
  // and continue so the run summary reflects the correct closed/failed state.
  async function disposeOrJournal(iso: Isolation, nodeId: string): Promise<void> {
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

  // Commit-before-emit + dual-close, then dispose — all inside this promise so
  // the closed.set happens-before dispose, and dispose happens-before any
  // dependent's isolate (the scheduler only schedules dependents after closed).
  async function settle(node: Node, outcome: RunNodeResult, startedAt: number): Promise<void> {
    const { verdict, iso } = outcome;
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
      durationMs: Date.now() - startedAt,
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
    });

    if (verdict.status === 'blocked') {
      // run-node already disposed the tree for non-done verdicts.
      blocked.add(node.id);
      await deps.journal.append({
        event: 'blocked',
        node: node.id,
        reason: verdict.evidence.blockedReason,
      });
      await deps.ledger.emitVerdict(verdict, plan.source);
      return;
    }

    if (verdict.status !== 'done' || iso === undefined) {
      // failed / dead / timeout — emit for the record; no node/<id> publish.
      // The evidence is quarantined first (the tree is gone after dispose).
      failed.add(node.id);
      await deps.ledger.emitVerdict(verdict, plan.source);
      if (iso) {
        await quarantineOrJournal(node, iso);
        await disposeOrJournal(iso, node.id);
      }
      return;
    }

    // ── done: commit-before-emit, dispose-before-visibility ─────────────────
    // The worktree work (markers, commit, emit) happens first; then the tree is
    // FULLY disposed; only then do closed/failed mutate. A dependent woken by
    // another node's resolution can therefore never see this node as closed
    // while its worktree still exists (ordering invariant under concurrency).
    let sha: string | undefined;
    let decision: { closed: boolean } | undefined;
    let failure: unknown;
    try {
      // Pre-commit marker safety — the auditor shares the cwd and may have
      // written markers after the in-node gate. A dirty tree FAILS, no commit.
      const lateMarkers = await deps.isolate.scanMarkers(iso.cwd);
      if (lateMarkers.length > 0) {
        throw new GateFailedError('marker', lateMarkers.join('\n'), -1); // N/A: marker scan has no exit code
      }

      const { sha: committed } = await deps.isolate.commitBranch(
        iso.cwd,
        `node/${node.id}`,
        commitMessage(plan, node, verdict),
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

    await disposeOrJournal(iso, node.id);

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

    const shouldClose = node.accept.audit ? decision.closed : true;
    if (shouldClose) {
      closed.set(node.id, sha);
      baseRefForClosed.set(node.id, sha); // pin to the immutable commit SHA, not the movable branch
      await deps.journal.append({ event: 'closed', node: node.id, sha });
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
    while (inflight.size < opts.maxConcurrency) {
      const next = ready().find((n) => !inflight.has(n.id));
      if (!next) break;
      const promise = runOne(next).finally(() => inflight.delete(next.id));
      inflight.set(next.id, promise);
    }
    if (inflight.size === 0) break;
    await Promise.race(inflight.values());
  }

  const skipped = plan.nodes
    .filter(
      (n) => !closed.has(n.id) && !failed.has(n.id) && !blocked.has(n.id) && !partial.has(n.id),
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
    quarantined: [...quarantined],
    alreadyVerified,
  };
  await deps.journal.append({ event: 'run-end', ...summary });
  return summary;
}

// ── helpers ──────────────────────────────────────────────────────────────────

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

// A node's isolate base refs: the resolved ref of each closed need, in order.
// A node with no needs isolates from repo HEAD.
function baseRefsFor(node: Node, baseRefForClosed: Map<string, string>): string[] {
  if (node.needs.length === 0) return [ROOT_BASE_REF];
  return node.needs.map((d) => baseRefForClosed.get(d) ?? `node/${d}`);
}

function commitMessage(plan: Plan, node: Node, verdict: Verdict): string {
  return `pleach: ${node.id} verified (${verdict.status})\n\nsource: ${plan.source}\ngoal: ${plan.goal}`;
}
