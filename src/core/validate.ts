import { PlanInvalidError } from './errors.ts';
import type { Plan } from './plan.ts';

export const DEFAULT_WORKER_PROVIDER = 'claude';

export function validatePlan(plan: Plan): { order: string[] } {
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

  return { order };
}
