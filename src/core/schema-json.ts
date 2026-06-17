import { z } from 'zod';
import { PlanSchema } from './plan.ts';

// Emit the @agent-contract/plan contract as a JSON Schema object — the
// machine-readable answer to "what format must a planner emit". Lives OUTSIDE
// plan.ts on purpose: plan.ts is pinned byte-for-byte to the vendored contract
// doc (drift test), and this is pleach tooling, not part of the shared schema.
// Pure & total: no I/O, deterministic.
export function planJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(PlanSchema) as Record<string, unknown>;
}
