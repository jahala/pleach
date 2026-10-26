import { PlanInvalidError } from './errors.ts';
import type { Node, Plan } from './plan.ts';
import { canonicalJson, sha256Hex } from './receipt.ts';
import { validatePlan } from './validate.ts';

// ── plan reload (issue #70) ─────────────────────────────────────────────────
//
// A run reads its plan once at start; a conductor who wants to recast an
// auditor or correct a prompt on a node that has not started had to abort and
// resume. This is the pure heart of the fix: given the plan in force, a
// re-read plan, and the ids that have already started, decide whether the
// reload applies and what the merged plan is. No filesystem, no clock — the
// loop supplies the re-read plan through an injected `reloadPlan` function.

// A fingerprint of a parsed plan: the sha256 of its canonical (sorted-key,
// undefined-dropped) JSON, so two parses of the same file compare equal and an
// unchanged file is detectable without diffing every field.
export function planFingerprint(plan: Plan): string {
  return sha256Hex(canonicalJson(plan));
}

export type ReloadDecision =
  | { kind: 'applied'; plan: Plan; applied: string[]; ignored: string[] }
  | { kind: 'refused'; detail: string };

// The one node-level comparison every decision uses. `canonicalJson` drops
// undefined and sorts keys, so two nodes with the same meaning compare equal.
function nodeKey(node: Node): string {
  return canonicalJson(node);
}

// Why a reload cannot even be considered: the plan's shape is load-bearing.
// Same node ids in the same order, same `needs` per node, same `source`. Any
// move names itself; the loop journals the refusal once and carries on.
function shapeRefusal(current: Plan, reloaded: Plan): string | null {
  if (current.source !== reloaded.source) {
    return `the plan's source moved from '${current.source}' to '${reloaded.source}'`;
  }
  const curIds = current.nodes.map((n) => n.id);
  const newIds = reloaded.nodes.map((n) => n.id);
  const idsMoved = curIds.length !== newIds.length || curIds.some((id, i) => id !== newIds[i]);
  if (idsMoved) {
    return (
      `the plan's node ids moved (added, removed, or reordered): ` +
      `was [${curIds.join(', ')}], now [${newIds.join(', ')}]`
    );
  }
  const byId = new Map(current.nodes.map((n) => [n.id, n]));
  for (const rn of reloaded.nodes) {
    const cur = byId.get(rn.id);
    if (cur === undefined) continue; // unreachable — ids already checked equal
    if (cur.needs.join('\u0000') !== rn.needs.join('\u0000')) {
      return (
        `node '${rn.id}' needs moved: was [${cur.needs.join(', ')}], ` +
        `now [${rn.needs.join(', ')}]`
      );
    }
  }
  return null;
}

/**
 * Merge a re-read plan into the plan in force.
 *
 * - The shape must be identical (same node ids in order, same `needs`, same
 *   `source`); any difference refuses the whole reload with a reason naming
 *   what moved.
 * - The reloaded plan must pass `validatePlan` with the run's providers; a
 *   refusal names its errors.
 * - A node that has not started takes the reloaded node, whatever changed.
 * - A node that has started keeps the node it started with; its change is
 *   ignored and named.
 * - `goal` and `maxConcurrency` take the reloaded values.
 *
 * Pure and total: returns the merged plan plus the applied/ignored node ids,
 * or a refusal — never throws.
 */
export function mergeReloadedPlan(
  current: Plan,
  reloaded: Plan,
  startedIds: ReadonlySet<string>,
  providers?: readonly string[],
): ReloadDecision {
  const shape = shapeRefusal(current, reloaded);
  if (shape !== null) return { kind: 'refused', detail: shape };

  try {
    validatePlan(reloaded, providers);
  } catch (err) {
    if (err instanceof PlanInvalidError) {
      return { kind: 'refused', detail: `invalid plan: ${err.reasons.join('; ')}` };
    }
    throw err;
  }

  const byId = new Map(current.nodes.map((n) => [n.id, n]));
  const applied: string[] = [];
  const ignored: string[] = [];
  const nodes: Node[] = reloaded.nodes.map((rn) => {
    const cur = byId.get(rn.id);
    // Unreachable after the shape check — ids are equal by construction.
    if (cur === undefined) return rn;
    if (startedIds.has(rn.id)) {
      if (nodeKey(cur) !== nodeKey(rn)) ignored.push(rn.id);
      return cur;
    }
    if (nodeKey(cur) !== nodeKey(rn)) applied.push(rn.id);
    return rn;
  });

  const plan: Plan = {
    goal: reloaded.goal,
    source: reloaded.source,
    ...(reloaded.maxConcurrency !== undefined ? { maxConcurrency: reloaded.maxConcurrency } : {}),
    nodes,
  };
  return { kind: 'applied', plan, applied, ignored };
}
