import { PlanInvalidError } from './errors.ts';
import type { Plan } from './plan.ts';

// issue #85 — the scope of a `--only` run. The operator names the nodes that
// matter now; pleach expands the names to everything those nodes need that the
// ledger does not already report closed, transitively through `needs`. Closed
// dependencies are bases — they stay out of the run, exactly as an already-
// verified node stays out of a plain run. Nothing else is scheduled, so a plan
// can be run a named slice at a time without a hand-made sub-plan.
//
// Pure and total: the plan, the named ids and the closed set are parameters;
// the answer is a function of them and nothing else. The only throw is a
// PlanInvalidError, raised before any lock is taken.

export interface RunScope {
  // The ids the operator named, de-duplicated in the order named.
  only: string[];
  // `only` plus every unclosed transitive dependency, in plan order.
  scope: string[];
}

// Normalise the operator's `--only` list: de-duplicated, and every id a plan
// node. An empty list or an id that is no node of the plan is a plan-level
// refusal — the caller raises it before the lock, exactly as `land --sinks`
// refuses an unknown id.
export function onlyIds(plan: Plan, only: readonly string[]): string[] {
  const ids = new Set(plan.nodes.map((n) => n.id));
  const unknown = [...new Set(only)].filter((id) => !ids.has(id));
  if (unknown.length > 0) {
    throw new PlanInvalidError([`--only names node(s) not in the plan: ${unknown.join(', ')}`]);
  }
  const named = [...new Set(only)];
  if (named.length === 0) {
    throw new PlanInvalidError(['--only requires at least one node id']);
  }
  return named;
}

// Expand the named ids to the run's full scope. `closed` is the ledger's closed
// set with implied ancestors already seeded (seedClosure), so a closed
// dependency stops the walk and its own ancestors never enter the scope — the
// work is contained in the descendant's commit.
export function computeRunScope(
  plan: Plan,
  only: readonly string[],
  closed: ReadonlySet<string>,
): RunScope {
  const named = onlyIds(plan, only);
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  const inScope = new Set<string>(named);
  const queue = [...named];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const node = byId.get(id);
    if (node === undefined) continue;
    for (const dep of node.needs) {
      if (closed.has(dep) || inScope.has(dep)) continue;
      inScope.add(dep);
      queue.push(dep);
    }
  }
  return {
    only: named,
    scope: plan.nodes.map((n) => n.id).filter((id) => inScope.has(id)),
  };
}
