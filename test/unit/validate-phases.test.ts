/**
 * Unit tests for the impl-terminal phase warning (ledger: D13).
 *
 * A phased node's GREEN gate is what proves the combined tree — base + red +
 * impl — actually passes the test. A plan whose phases end on `impl` never runs
 * it, so the node closes on the strength of a failing-test gate alone. That is
 * a plan defect, not an invalid plan: `pleach validate` names it and still
 * exits 0.
 *
 * Two pure surfaces: `planWarnings` (core) finds the offending nodes;
 * `validateReport` (face) shapes the report — `warnings[]` on the JSON line,
 * one stderr line per warning, exit code unchanged.
 */
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { planWarnings } from '../../src/core/validate.ts';
import { validateReport } from '../../src/faces/cli.ts';

function plan(nodes: unknown[]) {
  return PlanSchema.parse({ goal: 'g', source: 's', nodes });
}

const phased = (id: string, phases: string[], needs: string[] = []) => ({
  id,
  needs,
  work: {
    test: 'bun test',
    phases: phases.map((phase) => ({ phase, prompt: `${phase} prompt` })),
  },
});

describe('planWarnings — impl-terminal phases', () => {
  test('names a node whose last phase is impl', () => {
    const warnings = planWarnings(plan([phased('a', ['red', 'impl'])]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("node 'a'");
    expect(warnings[0]).toContain('phases end on impl');
    expect(warnings[0]).toContain('green gate');
  });

  test('a lone impl phase warns — there is still no green gate', () => {
    expect(planWarnings(plan([phased('solo', ['impl'])]))).toHaveLength(1);
  });

  test('only the LAST phase decides — impl before a closing green is fine', () => {
    expect(planWarnings(plan([phased('ok', ['red', 'impl', 'green'])]))).toEqual([]);
    expect(planWarnings(plan([phased('ok', ['red', 'green', 'impl'])]))).toHaveLength(1);
  });

  test('unphased work is never warned about', () => {
    const p = plan([
      { id: 'p', work: { prompt: 'do it' } },
      { id: 'c', needs: ['p'], work: { command: 'make' } },
    ]);
    expect(planWarnings(p)).toEqual([]);
  });

  test('every offender is named, in plan order, and clean nodes are not', () => {
    const p = plan([
      phased('first', ['red', 'impl']),
      phased('clean', ['red', 'impl', 'green'], ['first']),
      phased('last', ['red', 'impl'], ['clean']),
    ]);
    const warnings = planWarnings(p);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("node 'first'");
    expect(warnings[1]).toContain("node 'last'");
    expect(warnings.join('\n')).not.toContain("node 'clean'");
  });

  test('a clean plan warns about nothing', () => {
    expect(planWarnings(plan([phased('a', ['red', 'impl', 'green'])]))).toEqual([]);
  });
});

describe('validateReport — the `pleach validate` output', () => {
  test('carries warnings[] on the JSON line and one stderr line each; exit stays 0', () => {
    const p = plan([phased('a', ['red', 'impl']), phased('b', ['red', 'impl'], ['a'])]);
    const report = validateReport(p);

    expect(report.code).toBe(0);

    const lines = report.stdout.split('\n').filter((l: string) => l !== '');
    expect(lines).toHaveLength(1);
    const json = JSON.parse(lines[0] as string);
    expect(json.valid).toBe(true);
    expect(json.warnings).toEqual(planWarnings(p));
    expect(json.warnings).toHaveLength(2);

    const errLines = report.stderr.split('\n').filter((l: string) => l !== '');
    expect(errLines).toHaveLength(2);
    expect(errLines[0]).toContain("node 'a'");
    expect(errLines[1]).toContain("node 'b'");
  });

  test('warnings is always present — [] on a clean plan, and stderr stays silent', () => {
    const report = validateReport(plan([{ id: 'a', work: { command: 'make' } }]));
    expect(report.code).toBe(0);
    expect(report.stderr).toBe('');
    const json = JSON.parse(report.stdout);
    expect(json.warnings).toEqual([]);
  });

  test('the existing report keys survive alongside warnings', () => {
    const p = plan([
      { id: 'a', work: { command: 'make' }, accept: { smoke: 'bun test' } },
      { id: 'b', needs: ['a'], work: { prompt: 'do it' } },
    ]);
    const json = JSON.parse(validateReport(p).stdout);
    expect(json.order).toEqual(['a', 'b']);
    expect(json.waves).toEqual([['a'], ['b']]);
    expect(json.nodes).toEqual([
      { id: 'a', work: 'command', gates: ['smoke'] },
      { id: 'b', work: 'prompt', gates: [] },
    ]);
  });
});
