import { PlanInvalidError } from './errors.ts';
import type { Plan } from './plan.ts';

export const DEFAULT_WORKER_PROVIDER = 'claude';

export function validatePlan(plan: Plan): { order: string[]; waves: string[][] } {
  const reasons: string[] = [];

  if (plan.nodes.length === 0) {
    throw new PlanInvalidError(['plan has no nodes']);
  }

  // Check for duplicate ids
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const node of plan.nodes) {
    if (seen.has(node.id)) {
      duplicates.add(node.id);
    }
    seen.add(node.id);
  }
  for (const id of duplicates) {
    reasons.push(`duplicate node id: '${id}'`);
  }

  const idSet = new Set(plan.nodes.map((n) => n.id));

  // Check for unknown needs references
  for (const node of plan.nodes) {
    for (const dep of node.needs) {
      if (!idSet.has(dep)) {
        reasons.push(`node '${node.id}' needs unknown id: '${dep}'`);
      }
    }
  }

  // Check model-diversity rule
  for (const node of plan.nodes) {
    if (node.accept.audit) {
      const workerProvider = node.worker.provider ?? DEFAULT_WORKER_PROVIDER;
      if (node.accept.audit.provider === workerProvider) {
        reasons.push(
          `node '${node.id}': audit provider '${node.accept.audit.provider}' must differ from worker provider (model diversity rule)`,
        );
      }
    }
  }

  // If structural errors exist before toposort, throw now (toposort requires clean graph)
  if (reasons.length > 0) {
    throw new PlanInvalidError(reasons);
  }

  // Kahn's algorithm toposort — detect cycles
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of plan.nodes) {
    if (!inDegree.has(node.id)) inDegree.set(node.id, 0);
    if (!adjacency.has(node.id)) adjacency.set(node.id, []);
  }

  for (const node of plan.nodes) {
    for (const dep of node.needs) {
      // dep → node (dep must come before node)
      const successors = adjacency.get(dep) ?? [];
      successors.push(node.id);
      adjacency.set(dep, successors);
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
    }
  }

  // Parallel execution batches, computed on a copy of inDegree so the order
  // toposort below stays byte-identical.
  const waves = computeWaves(plan, adjacency, inDegree);

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    // length check above guarantees shift() is defined
    const id = queue.shift() as string;
    order.push(id);
    for (const successor of adjacency.get(id) ?? []) {
      const newDeg = (inDegree.get(successor) ?? 0) - 1;
      inDegree.set(successor, newDeg);
      if (newDeg === 0) queue.push(successor);
    }
  }

  if (order.length !== plan.nodes.length) {
    throw new PlanInvalidError(['dependency cycle detected in plan nodes']);
  }

  return { order, waves };
}

// Level-order Kahn: each wave is the set of nodes whose dependencies are all
// satisfied at that step, so a wave's nodes can run concurrently. Operates on a
// copy of inDegree; within-wave order follows plan.nodes for stability.
function computeWaves(
  plan: Plan,
  adjacency: Map<string, string[]>,
  inDegree: Map<string, number>,
): string[][] {
  const waves: string[][] = [];
  const remaining = new Set(plan.nodes.map((n) => n.id));
  const deg = new Map(inDegree);
  while (remaining.size > 0) {
    const wave = plan.nodes
      .filter((n) => remaining.has(n.id) && (deg.get(n.id) ?? 0) === 0)
      .map((n) => n.id);
    if (wave.length === 0) break; // cyclic graph — validatePlan's order check throws
    for (const id of wave) {
      remaining.delete(id);
      for (const succ of adjacency.get(id) ?? []) {
        deg.set(succ, (deg.get(succ) ?? 0) - 1);
      }
    }
    waves.push(wave);
  }
  return waves;
}

export interface NodeSummary {
  id: string;
  work: 'command' | 'prompt' | 'phases';
  gates: string[];
}

// A per-node display projection for `pleach validate`: the work discriminant
// and the gates a node declares (setup, smoke, audit:<provider>). Pure.
export function nodeSummaries(plan: Plan): NodeSummary[] {
  return plan.nodes.map((node) => {
    let work: NodeSummary['work'] = 'prompt';
    if ('command' in node.work) work = 'command';
    else if ('phases' in node.work) work = 'phases';
    const gates: string[] = [];
    if (node.setup) gates.push('setup');
    if (node.accept.smoke) gates.push('smoke');
    if (node.accept.audit) gates.push(`audit:${node.accept.audit.provider}`);
    return { id: node.id, work, gates };
  });
}
