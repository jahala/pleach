/**
 * `pleach schema` agrees with the validator about what is optional (ledger: D19, #68).
 *
 * `pleach schema` prints planJsonSchema(). The zod Plan gives several fields a
 * default (`.default()` / `.prefault()`), so `PlanSchema.parse` accepts a plan
 * that omits them. The emitted JSON Schema listed those same fields as
 * `required`, so a planner reading the schema was told to emit fields the
 * validator never asks for, and a minimal plan the validator accepts failed
 * the schema.
 *
 * The class check walks the zod Plan beside the emitted schema: at every
 * object, a key whose zod type carries a default is absent from `required`,
 * and a key that is neither defaulted nor optional stays in it. The named
 * fields from #68 pin the walk so it cannot pass by finding nothing. A small
 * validator over the keywords the emitted schema uses (type, properties,
 * required, additionalProperties, items, anyOf, enum, pattern) then checks that
 * minimal plans the validator accepts conform; negative controls prove that
 * validator discriminates.
 */
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { planJsonSchema } from '../../src/core/schema-json.ts';
import { validatePlan } from '../../src/core/validate.ts';

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  enum?: unknown[];
  pattern?: string;
};

// The zod v4 introspection surface this test reads: every schema carries its
// definition at `_zod.def`, discriminated by `type`.
type ZodDef = {
  type: string;
  shape?: Record<string, ZodLike>;
  element?: ZodLike;
  options?: ZodLike[];
  innerType?: ZodLike;
};
type ZodLike = { _zod: { def: ZodDef } };

const isDefaulted = (t: ZodLike) => ['default', 'prefault'].includes(t._zod.def.type);
const isOptional = (t: ZodLike) => t._zod.def.type === 'optional';

function unwrap(t: ZodLike): ZodLike {
  const { type, innerType } = t._zod.def;
  return ['default', 'prefault', 'optional'].includes(type) && innerType ? unwrap(innerType) : t;
}

type ObjectPair = { path: string; shape: Record<string, ZodLike>; json: JsonSchema };

// Every zod object in the Plan paired with the JSON Schema node emitted for it.
function objectPairs(z: ZodLike, json: JsonSchema | undefined, path: string): ObjectPair[] {
  if (json === undefined) throw new TypeError(`emitted schema has no node at ${path}`);
  const def = unwrap(z)._zod.def;
  if (def.type === 'object' && def.shape) {
    const shape = def.shape;
    return [
      { path, shape, json },
      ...Object.entries(shape).flatMap(([k, v]) =>
        objectPairs(v, json.properties?.[k], `${path}.${k}`),
      ),
    ];
  }
  if (def.type === 'array' && def.element) return objectPairs(def.element, json.items, `${path}[]`);
  if (def.type === 'union' && def.options) {
    return def.options.flatMap((o, i) => objectPairs(o, json.anyOf?.[i], `${path}|${i}`));
  }
  return [];
}

// Validation errors of `value` against the keywords the emitted schema uses; [] = conforms.
function conform(value: unknown, s: JsonSchema, path: string): string[] {
  if (s.anyOf) {
    const matched = s.anyOf.some((branch) => conform(value, branch, path).length === 0);
    return matched ? [] : [`${path}: matches no anyOf branch`];
  }
  if (s.enum && !s.enum.includes(value)) return [`${path}: not in enum`];
  switch (s.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [`${path}: not an object`];
      }
      const obj = value as Record<string, unknown>;
      const missing = (s.required ?? [])
        .filter((k) => !(k in obj))
        .map((k) => `${path}.${k}: required`);
      const present = Object.entries(obj).flatMap(([k, v]) => {
        const sub = s.properties?.[k];
        if (sub) return conform(v, sub, `${path}.${k}`);
        return s.additionalProperties === false ? [`${path}.${k}: not allowed`] : [];
      });
      return [...missing, ...present];
    }
    case 'array': {
      const items = s.items;
      if (!Array.isArray(value)) return [`${path}: not an array`];
      return items ? value.flatMap((v, i) => conform(v, items, `${path}[${i}]`)) : [];
    }
    case 'string':
      if (typeof value !== 'string') return [`${path}: not a string`];
      return s.pattern && !new RegExp(s.pattern).test(value) ? [`${path}: fails pattern`] : [];
    case 'integer':
      return Number.isInteger(value) ? [] : [`${path}: not an integer`];
    case 'number':
      return typeof value === 'number' ? [] : [`${path}: not a number`];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path}: not a boolean`];
    default:
      return [];
  }
}

const schema = () => planJsonSchema() as JsonSchema;
const pairs = () => objectPairs(PlanSchema as unknown as ZodLike, schema(), 'plan');
const at = (path: string) => {
  const pair = pairs().find((p) => p.path === path);
  if (!pair) throw new TypeError(`no zod object at ${path}`);
  return pair;
};

const MINIMAL = {
  prompt: { goal: 'g', source: 's.html', nodes: [{ id: 'a', work: { prompt: 'do it' } }] },
  command: { goal: 'g', source: 's.html', nodes: [{ id: 'a', work: { command: 'bun test' } }] },
  test: {
    goal: 'g',
    source: 's.html',
    nodes: [{ id: 'a', work: { test: 'bun test', phases: [{ phase: 'red', prompt: 'p' }] } }],
  },
  'empty policy': {
    goal: 'g',
    source: 's.html',
    nodes: [{ id: 'a', work: { prompt: 'p' }, policy: {} }],
  },
};

describe('pleach schema: defaulted fields are optional', () => {
  // ledger: D19
  test('every zod-defaulted key is absent from its object`s required list', () => {
    const offenders = pairs().flatMap(({ path, shape, json }) =>
      Object.entries(shape)
        .filter(([k, t]) => isDefaulted(t) && (json.required ?? []).includes(k))
        .map(([k]) => `${path}.${k}`),
    );
    expect(offenders).toEqual([]);
  });

  // ledger: D19
  test('every key that is neither defaulted nor optional stays required', () => {
    const dropped = pairs().flatMap(({ path, shape, json }) =>
      Object.entries(shape)
        .filter(([k, t]) => !isDefaulted(t) && !isOptional(t) && !(json.required ?? []).includes(k))
        .map(([k]) => `${path}.${k}`),
    );
    expect(dropped).toEqual([]);
  });

  // ledger: D19 — the fields #68 names; pins the walk so it cannot pass vacuously.
  test('Node.required and policy.required are exactly the non-defaulted fields', () => {
    const node = at('plan.nodes[]');
    const policy = at('plan.nodes[].policy');
    for (const k of ['worker', 'needs', 'accept', 'policy', 'closes']) {
      expect(isDefaulted(node.shape[k] as ZodLike)).toBe(true);
    }
    for (const k of ['maxAttempts', 'onDead', 'reauditWhen']) {
      expect(isDefaulted(policy.shape[k] as ZodLike)).toBe(true);
    }
    expect([...(node.json.required ?? [])].sort()).toEqual(['id', 'work']);
    expect(policy.json.required ?? []).toEqual([]);
    expect([...(at('plan').json.required ?? [])].sort()).toEqual(['goal', 'nodes', 'source']);
  });
});

describe('pleach schema: a plan the validator accepts conforms to the emitted schema', () => {
  for (const [name, plan] of Object.entries(MINIMAL)) {
    // ledger: D19
    test(`minimal ${name} plan: PlanSchema + validatePlan accept it, and it conforms`, () => {
      const parsed = PlanSchema.parse(plan);
      expect(() => validatePlan(parsed)).not.toThrow();
      expect(conform(plan, schema(), 'plan')).toEqual([]);
    });
  }

  // Negative controls: the in-test validator refuses what the schema forbids. Built
  // from a fully-defaulted node so each control isolates one fault.
  test('the validator discriminates: missing goal, missing work, empty work, bad id', () => {
    const base = PlanSchema.parse(MINIMAL.prompt);
    const node = base.nodes[0];
    const noWork = Object.fromEntries(Object.entries(node ?? {}).filter(([k]) => k !== 'work'));
    expect(conform({ source: 's', nodes: [] }, schema(), 'plan')).toEqual(['plan.goal: required']);
    expect(conform({ ...base, nodes: [noWork] }, schema(), 'plan')).toEqual([
      'plan.nodes[0].work: required',
    ]);
    expect(conform({ ...base, nodes: [{ ...node, work: {} }] }, schema(), 'plan')).toEqual([
      'plan.nodes[0].work: matches no anyOf branch',
    ]);
    expect(conform({ ...base, nodes: [{ ...node, id: '-a' }] }, schema(), 'plan')).toEqual([
      'plan.nodes[0].id: fails pattern',
    ]);
    const policy = { ...node?.policy, onDead: 'retry' };
    expect(conform({ ...base, nodes: [{ ...node, policy }] }, schema(), 'plan')).toEqual([
      'plan.nodes[0].policy.onDead: not in enum',
    ]);
  });

  test('a fully-defaulted parsed plan conforms too (the schema still describes the output)', () => {
    expect(conform(PlanSchema.parse(MINIMAL.prompt), schema(), 'plan')).toEqual([]);
  });
});
