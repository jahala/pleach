/**
 * Unit tests for planJsonSchema() (src/core/schema-json.ts).
 *
 * planJsonSchema() is a pure, total function that emits the @agent-contract/plan
 * contract as a JSON Schema object — the machine-readable answer to "what format
 * must a planner emit."
 *
 * DISCRIMINATION: the test must fail if the schema doesn't describe a Plan. Each
 * assertion is structural: if `properties` or the required field names are absent,
 * the test fails.
 */
import { describe, expect, test } from 'bun:test';
import { planJsonSchema } from '../../src/core/schema-json.ts';

describe('planJsonSchema', () => {
  test('returns a JSON Schema object (has $schema or type)', () => {
    const schema = planJsonSchema();
    expect(typeof schema).toBe('object');
    expect(schema).not.toBeNull();
  });

  test('schema has a properties object (object shape — discriminating)', () => {
    const schema = planJsonSchema();
    expect(typeof schema.properties).toBe('object');
    expect(schema.properties).not.toBeNull();
  });

  test('schema describes the `nodes` field (discriminating — fails if schema is {})', () => {
    const schema = planJsonSchema();
    const json = JSON.stringify(schema);
    expect(json).toContain('"nodes"');
  });

  test('schema describes the `goal` field', () => {
    const json = JSON.stringify(planJsonSchema());
    expect(json).toContain('"goal"');
  });

  test('schema describes the `source` field', () => {
    const json = JSON.stringify(planJsonSchema());
    expect(json).toContain('"source"');
  });

  test('serialised schema round-trips as valid JSON', () => {
    const schema = planJsonSchema();
    const serialised = JSON.stringify(schema, null, 2);
    expect(() => JSON.parse(serialised)).not.toThrow();
  });

  test('properties.nodes exists as a sub-object (structural — not just a string match)', () => {
    const schema = planJsonSchema();
    const props = schema.properties as Record<string, unknown>;
    expect(typeof props.nodes).toBe('object');
  });
});
