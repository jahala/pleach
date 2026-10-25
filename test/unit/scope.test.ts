import { describe, expect, test } from 'bun:test';
import { PlanInvalidError } from '../../src/core/errors.ts';
import type { Node, Plan } from '../../src/core/plan.ts';
import { computeRunScope, onlyIds } from '../../src/core/scope.ts';

// issue #85 — the scope of a `--only` run: the named nodes plus their unclosed
// transitive dependencies, computed purely from the plan, the named ids and the
// closed set. The function is the one place the subset is decided, so it is
// tested at real size as well as on the small cases the loop tests exercise.

function node(id: string, needs: string[] = []): Node {
  return {
    id,
    worker: {},
    work: { prompt: `build ${id}` },
    needs,
    accept: {},
    policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
    closes: [],
  };
}

function plan(nodes: Node[]): Plan {
  return { goal: 'g', source: 's', nodes };
}

const none = new Set<string>();

describe('onlyIds', () => {
  test('de-duplicates and preserves the order named', () => {
    const p = plan([node('a'), node('b'), node('c')]);
    expect(onlyIds(p, ['c', 'a', 'c'])).toEqual(['c', 'a']);
  });

  test('refuses an id that is no node of the plan, naming it', () => {
    const p = plan([node('a')]);
    expect(() => onlyIds(p, ['a', 'typo'])).toThrow(PlanInvalidError);
    expect(() => onlyIds(p, ['a', 'typo'])).toThrow('typo');
  });

  test('refuses an empty list', () => {
    const p = plan([node('a')]);
    expect(() => onlyIds(p, [])).toThrow(PlanInvalidError);
  });
});

describe('computeRunScope', () => {
  test('a named sink pulls in its unclosed chain, transitively', () => {
    // a → b → c → d; name d with nothing closed → every ancestor in scope.
    const p = plan([node('a'), node('b', ['a']), node('c', ['b']), node('d', ['c']), node('x')]);
    expect(computeRunScope(p, ['d'], none)).toEqual({ only: ['d'], scope: ['a', 'b', 'c', 'd'] });
  });

  test('closed dependencies are not rescheduled — they stay bases', () => {
    // b needs a; a is closed → scope is b alone, a stays a base.
    const p = plan([node('a'), node('b', ['a']), node('x')]);
    expect(computeRunScope(p, ['b'], new Set(['a']))).toEqual({
      only: ['b'],
      scope: ['b'],
    });
  });

  test('the walk stops at a closed dependency, so its own ancestors never enter', () => {
    // c needs b needs a; b is closed (its work contains a's). Naming c must not
    // reschedule a or b — only c runs.
    const p = plan([node('a'), node('b', ['a']), node('c', ['b'])]);
    expect(computeRunScope(p, ['c'], new Set(['b']))).toEqual({ only: ['c'], scope: ['c'] });
  });

  test('a named node that is already closed is in scope but schedules nothing else', () => {
    const p = plan([node('a'), node('b', ['a'])]);
    expect(computeRunScope(p, ['b'], new Set(['a', 'b']))).toEqual({
      only: ['b'],
      scope: ['b'],
    });
  });

  test('two named nodes each pull their own unclosed chains, de-duplicated', () => {
    const p = plan([node('a'), node('b', ['a']), node('c', ['a']), node('d', ['c'])]);
    expect(computeRunScope(p, ['b', 'd'], none)).toEqual({
      only: ['b', 'd'],
      scope: ['a', 'b', 'c', 'd'],
    });
  });

  test('the scope is returned in plan order, whatever order the names came in', () => {
    const p = plan([node('a'), node('b'), node('c', ['a', 'b'])]);
    expect(computeRunScope(p, ['c'], none)).toEqual({ only: ['c'], scope: ['a', 'b', 'c'] });
  });

  test('an unknown id is refused', () => {
    const p = plan([node('a')]);
    expect(() => computeRunScope(p, ['nosuch'], none)).toThrow(PlanInvalidError);
    expect(() => computeRunScope(p, ['nosuch'], none)).toThrow('nosuch');
  });

  test('real size: a five-hundred-node chain names its unclosed suffix only', () => {
    // n0 ← n1 ← … ← n499; the first 100 are closed. Naming the sink must pull
    // in exactly the 400 unclosed nodes, in order, and nothing before the
    // closed prefix.
    const nodes: Node[] = Array.from({ length: 500 }, (_, i) =>
      node(`n${i}`, i === 0 ? [] : [`n${i - 1}`]),
    );
    const closed = new Set(Array.from({ length: 100 }, (_, i) => `n${i}`));
    const { only, scope } = computeRunScope(plan(nodes), ['n499'], closed);
    expect(only).toEqual(['n499']);
    expect(scope).toEqual(Array.from({ length: 400 }, (_, i) => `n${i + 100}`));
  });

  test('real size: a wide fan-out names the whole unclosed lattice once', () => {
    // One sink needs 300 steps; every step and the sink are in scope, each once.
    const steps = Array.from({ length: 300 }, (_, i) => node(`s${i}`));
    const sink = node(
      'sink',
      steps.map((s) => s.id),
    );
    const { scope } = computeRunScope(plan([...steps, sink]), ['sink'], none);
    expect(scope).toHaveLength(301);
    expect(new Set(scope).size).toBe(301);
    expect(scope[scope.length - 1]).toBe('sink');
  });
});
