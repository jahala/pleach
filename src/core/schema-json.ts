import { z } from 'zod';
import { PlanSchema } from './plan.ts';

// Wrappers whose parse fills an absent key, so the key is optional to a planner.
const DEFAULTED = new Set(['default', 'prefault']);

// Emit the @agent-contract/plan contract as a JSON Schema object — the
// machine-readable answer to "what format must a planner emit". Lives OUTSIDE
// plan.ts on purpose: plan.ts is pinned byte-for-byte to the vendored contract
// doc (drift test), and this is pleach tooling, not part of the shared schema.
// zod's output mode lists defaulted keys as required (the parsed value always
// has them); a planner writes the input, so each object drops its defaulted
// keys from `required` (#68, ledger D19). Pure & total: no I/O, deterministic.
export function planJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(PlanSchema, {
    override: ({ zodSchema, jsonSchema }) => {
      const def = zodSchema._zod.def;
      if (def.type !== 'object' || !jsonSchema.required) return;
      const required = jsonSchema.required.filter(
        (key) => !DEFAULTED.has(def.shape[key]?._zod.def.type ?? ''),
      );
      if (required.length > 0) jsonSchema.required = required;
      else delete jsonSchema.required;
    },
  }) as Record<string, unknown>;
}
