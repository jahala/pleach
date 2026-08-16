import { LandBlockedError, LandConflictError, RebuildRequiredError } from '../core/errors.ts';
import type { Plan } from '../core/plan.ts';
import { sinkIds, validatePlan } from '../core/validate.ts';
import type { ConductorDeps } from './deps.ts';
import { resolveBaseRef, seedClosure } from './run-plan.ts';

// ── land: the last mile (ledger B3) ──────────────────────────────────────────
//
// Verified work sits on node/<id> branches; landPlan merges the plan's sinks
// onto the branch checked out in repoRoot. Policy lives here — every plan node
// must be verified-closed, sinks resolve through the B1/C5 baseRef chain — and
// the git mechanics live in the isolate seam's land(), which builds the merges
// in a throwaway worktree and only ever touches the checkout via --ff-only.
// Composes injected seams only; holds the (repo, source) conductor lock.

export interface LandOpts {
  repoRoot: string;
}

export interface LandSummary {
  branch: string;
  sha: string;
  landed: string[];
}

export async function landPlan(
  plan: Plan,
  deps: ConductorDeps,
  opts: LandOpts,
): Promise<LandSummary> {
  validatePlan(plan); // throws PlanInvalidError — the face maps exit 2.

  const lock = await deps.lock.acquire(opts.repoRoot, plan.source);
  try {
    await deps.journal.append({ event: 'land-start', goal: plan.goal });

    // Defensive copy (M3), then the same implied-ancestor closure as runPlan.
    const closed = new Map<string, string | null>(await deps.ledger.readClosed(plan.source));
    seedClosure(plan, closed);

    // Landing is all-or-nothing: half a plan on the branch would break the
    // verified-only invariant the node branches exist to protect.
    const unclosed = plan.nodes.filter((n) => !closed.has(n.id)).map((n) => n.id);
    if (unclosed.length > 0) {
      await deps.journal.append({ event: 'land-blocked', unverified: unclosed });
      throw new LandBlockedError(`unverified node(s): ${unclosed.join(', ')}`);
    }

    // Resolve each sink through the baseRef chain — a vanished ref is a
    // rebuild, a force-moved branch is refused (C5 verify-before-use).
    const sinks = sinkIds(plan);
    const refs: string[] = [];
    for (const id of sinks) {
      const resolved = await resolveBaseRef(deps, opts.repoRoot, id, closed.get(id) ?? null);
      if (resolved === null) {
        await deps.journal.append({ event: 'rebuild-required', node: id });
        throw new RebuildRequiredError(id);
      }
      refs.push(resolved);
    }

    let landed: { branch: string; sha: string };
    try {
      landed = await deps.isolate.land(opts.repoRoot, refs);
    } catch (err) {
      // A refused land must be explainable from the journal alone.
      if (err instanceof LandConflictError) {
        await deps.journal.append({ event: 'land-conflict', ref: err.ref, files: err.files });
      } else if (err instanceof LandBlockedError) {
        await deps.journal.append({ event: 'land-blocked', reason: err.reason });
      }
      throw err;
    }
    await deps.journal.append({
      event: 'landed',
      branch: landed.branch,
      sha: landed.sha,
      nodes: sinks,
    });
    return { branch: landed.branch, sha: landed.sha, landed: sinks };
  } finally {
    await lock.release();
  }
}
