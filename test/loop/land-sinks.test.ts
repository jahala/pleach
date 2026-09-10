// D18 §2 — `pleach land --sinks <id,…>`: the operator names which verified
// sinks to land. The all-or-nothing rule exists so half a plan never reaches
// the branch, but on a live garden it also strands a settled node behind
// whatever else the plan is still building. `--sinks` is the operator saying
// which verified work lands now: the named ids become the landing's sinks
// outright — the stack, the setups, the smokes and the publish all cover
// exactly them — and a named id that is unknown or unverified is refused by
// name before any stack is built. Without the flag nothing changes.
// In-memory seams per the testing doctrine; the harness's landStack encodes
// the merged refs into the stack cwd so the gate's reach is observable.
import { describe, expect, test } from 'bun:test';
import { LandBlockedError, PlanInvalidError } from '../../src/core/errors.ts';
import { PlanSchema } from '../../src/core/plan.ts';
import { landPlan } from '../../src/loop/land.ts';
import { makeHarness } from './harness.ts';

const REPO = '/r';

function plan(nodes: { id: string; needs?: string[]; setup?: string; smoke?: string }[]) {
  return PlanSchema.parse({
    goal: 'land a subset',
    source: 'polyglot.html',
    nodes: nodes.map((n) => ({
      id: n.id,
      work: { command: `build-${n.id}` },
      needs: n.needs ?? [],
      ...(n.setup !== undefined ? { setup: n.setup } : {}),
      ...(n.smoke !== undefined ? { accept: { smoke: n.smoke } } : {}),
    })),
  });
}

// Verified ids close to `sha-<id>` and publish their node/<id> branch there.
function closedHarness(
  ids: string[],
  execScript?: (argv: readonly string[], cwd: string) => { output: string; exitCode: number },
) {
  const closed = new Map(ids.map((id) => [id, `sha-${id}`]));
  const refs: Record<string, string> = {};
  for (const id of ids) {
    refs[`node/${id}`] = `sha-${id}`;
    refs[`sha-${id}`] = `sha-${id}`;
  }
  return makeHarness({ closed, refs, ...(execScript ? { execScript } : {}) });
}

describe('landPlan --sinks (D18)', () => {
  test('lands the named verified sink while the rest of the plan is unverified', async () => {
    const p = plan([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const h = closedHarness(['a', 'b']); // c never closed

    const summary = await landPlan(p, h.deps, { repoRoot: REPO, sinks: ['b'] });

    expect(summary.landed).toEqual(['b']);
    // The stack and the publish saw exactly the subset.
    expect(h.log.of('landStack').map((e) => e.detail)).toEqual(['land:node/b']);
    expect(h.log.of('land')[0]?.detail).toBe('node/b');
  });

  test('the named ids become the sinks outright, even an interior node', async () => {
    // `b` needs `a`; both verified. sinkIds(plan) is ['b'], but the operator
    // named `a` — a subset is not a filter over the plan's own sinks.
    const p = plan([{ id: 'a' }, { id: 'b', needs: ['a'] }]);
    const h = closedHarness(['a', 'b']);

    const summary = await landPlan(p, h.deps, { repoRoot: REPO, sinks: ['a'] });

    expect(summary.landed).toEqual(['a']);
    expect(h.log.of('land')[0]?.detail).toBe('node/a');
  });

  test('a named node that is not verified is refused by name, nothing built', async () => {
    // `d` is unverified too, but nobody named it — this landing is about the
    // named ids, so the refusal (and the journal) name `c` and only `c`.
    const p = plan([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
    const h = closedHarness(['a', 'b']);

    const landing = landPlan(p, h.deps, { repoRoot: REPO, sinks: ['b', 'c'] });

    await expect(landing).rejects.toBeInstanceOf(LandBlockedError);
    await expect(landPlan(p, h.deps, { repoRoot: REPO, sinks: ['b', 'c'] })).rejects.toThrow('c');
    // Refused before any stack was built — not after the merges.
    expect(h.log.count('landStack')).toBe(0);
    expect(h.log.count('land')).toBe(0);
    const blocked = h.journal.find((e) => e.event === 'land-blocked');
    expect(blocked?.unverified).toEqual(['c']);
  });

  test('a named id that is not a plan node is a plan error naming it, nothing built', async () => {
    const p = plan([{ id: 'a' }, { id: 'b' }]);
    const h = closedHarness(['a', 'b']);

    const landing = landPlan(p, h.deps, { repoRoot: REPO, sinks: ['a', 'typo'] });

    await expect(landing).rejects.toBeInstanceOf(PlanInvalidError);
    await expect(landPlan(p, h.deps, { repoRoot: REPO, sinks: ['a', 'typo'] })).rejects.toThrow(
      'typo',
    );
    expect(h.log.count('landStack')).toBe(0);
  });

  test('the composition gate covers only the subset — an excluded sink never runs', async () => {
    // `b` is verified too, but it is not in the landing: neither its setup nor
    // its smoke may reach the stack, and its red smoke must not refuse `a`.
    const ran: string[] = [];
    const p = plan([
      { id: 'a', setup: 'install-a', smoke: 'test-a' },
      { id: 'b', setup: 'install-b', smoke: 'test-b' },
    ]);
    const h = closedHarness(['a', 'b'], (argv, cwd) => {
      if (!cwd.startsWith('land:')) return { output: '', exitCode: 0 };
      ran.push(argv.join(' '));
      return argv[0] === 'test-b'
        ? { output: "b's smoke is red", exitCode: 1 }
        : { output: '', exitCode: 0 };
    });

    const summary = await landPlan(p, h.deps, { repoRoot: REPO, sinks: ['a'] });

    expect(summary.landed).toEqual(['a']);
    expect(ran).toEqual(['install-a', 'test-a']);
    const gate = h.journal.find((e) => e.event === 'land-gate');
    expect(gate?.sinks).toEqual(['a']);
  });

  test('without --sinks the all-or-nothing refusal is unchanged', async () => {
    const p = plan([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const h = closedHarness(['a', 'b']);

    await expect(landPlan(p, h.deps, { repoRoot: REPO })).rejects.toThrow(LandBlockedError);
    await expect(landPlan(p, h.deps, { repoRoot: REPO })).rejects.toThrow('c');
    expect(h.log.count('landStack')).toBe(0);
  });

  test('land-start journals the ids landed — the subset when named, every sink when not', async () => {
    const p = plan([{ id: 'a' }, { id: 'b' }]);

    const subset = closedHarness(['a', 'b']);
    await landPlan(p, subset.deps, { repoRoot: REPO, sinks: ['a'] });
    expect(subset.journal.find((e) => e.event === 'land-start')?.sinks).toEqual(['a']);

    const whole = closedHarness(['a', 'b']);
    await landPlan(p, whole.deps, { repoRoot: REPO });
    expect(whole.journal.find((e) => e.event === 'land-start')?.sinks).toEqual(['a', 'b']);
  });
});
