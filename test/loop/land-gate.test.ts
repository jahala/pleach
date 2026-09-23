// The land gate: nodes verify on their own merged-from-
// deps trees, but the landed COMBINATION of sinks was never gate-tested until
// now. The gate = the union of the sinks' own smoke commands (deduped, exact
// string) run on the stack tip in the throwaway worktree; one flaky retry of
// the failing command; cumulative-context bisect names the culprit; policy
// stays refuse-all — the bisect's product is the DIAGNOSTIC, never a partial
// landing. In-memory seams; the harness's landStack encodes merged refs into
// the stack cwd so execScript can simulate interaction failures.
import { describe, expect, test } from 'bun:test';
import { LandBlockedError } from '../../src/core/errors.ts';
import { PlanSchema } from '../../src/core/plan.ts';
import { landPlan } from '../../src/loop/land.ts';
import { makeHarness } from './harness.ts';

const OPTS = { repoRoot: '/r' };

// Two independent sinks with their own smokes; optional third for dedup.
function sinkPlan(smokes: { a: string; b?: string; c?: string }) {
  const nodes = [
    { id: 'a', work: { command: 'build-a' }, accept: { smoke: smokes.a } },
    ...(smokes.b !== undefined
      ? [{ id: 'b', work: { command: 'build-b' }, accept: { smoke: smokes.b } }]
      : []),
    ...(smokes.c !== undefined
      ? [{ id: 'c', work: { command: 'build-c' }, accept: { smoke: smokes.c } }]
      : []),
  ];
  return PlanSchema.parse({ goal: 'g', source: 's', nodes });
}

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

describe('the land gate (§A)', () => {
  test('green stack: gate runs each sink smoke on the stack tip, then lands', async () => {
    const gateCalls: string[] = [];
    const h = closedHarness(['a', 'b'], (argv, cwd) => {
      if (cwd.startsWith('land:')) gateCalls.push(`${cwd} ${argv.join(' ')}`);
      return { output: '', exitCode: 0 };
    });
    const plan = sinkPlan({ a: 'test-a', b: 'test-b' });

    const summary = await landPlan(plan, h.deps, OPTS);

    expect(summary.landed.sort()).toEqual(['a', 'b']);
    expect(gateCalls.filter((c) => /test-[ab]/.test(c)).length).toBe(2);
    expect(h.journal.some((e) => e.event === 'land-gate')).toBe(true);
    expect(h.journal.some((e) => e.event === 'landed')).toBe(true);
  });

  test('identical smoke strings run once (dedup)', async () => {
    const gateCalls: string[] = [];
    const h = closedHarness(['a', 'b', 'c'], (argv, cwd) => {
      if (cwd.startsWith('land:')) gateCalls.push(argv.join(' '));
      return { output: '', exitCode: 0 };
    });
    const plan = sinkPlan({ a: 'shared-suite', b: 'shared-suite', c: 'shared-suite' });

    await landPlan(plan, h.deps, OPTS);

    expect(gateCalls.filter((c) => c === 'shared-suite').length).toBe(1);
  });

  test('interaction culprit: combination fails, bisect names it, nothing lands', async () => {
    // test-b fails ONLY when both node/a and node/b are in the stack — the
    // clean-merge semantic conflict no per-node gate can see.
    const h = closedHarness(['a', 'b'], (argv, cwd) => {
      if (argv[0] === 'test-b' && cwd.includes('node/a') && cwd.includes('node/b')) {
        return { output: 'combined state broke b', exitCode: 1 };
      }
      return { output: '', exitCode: 0 };
    });
    const plan = sinkPlan({ a: 'test-a', b: 'test-b' });

    await expect(landPlan(plan, h.deps, OPTS)).rejects.toThrow(LandBlockedError);

    // Nothing published.
    expect(h.log.of('land').length).toBe(0);
    // The culprit is named with its evidence.
    const culprit = h.journal.find((e) => e.event === 'land-culprit');
    expect(culprit).toBeDefined();
    expect(String(culprit?.outputTail)).toContain('combined state broke b');
    expect(h.journal.some((e) => e.event === 'land-bisect')).toBe(true);
  });

  test('flaky smoke: fails once, passes the retry, lands with the retry journaled', async () => {
    let failures = 0;
    const h = closedHarness(['a', 'b'], (argv, cwd) => {
      if (argv[0] === 'test-a' && cwd.startsWith('land:') && failures === 0) {
        failures += 1;
        return { output: 'jsdom timeout', exitCode: 1 };
      }
      return { output: '', exitCode: 0 };
    });
    const plan = sinkPlan({ a: 'test-a', b: 'test-b' });

    const summary = await landPlan(plan, h.deps, OPTS);

    expect(summary.landed.sort()).toEqual(['a', 'b']);
    expect(h.journal.some((e) => e.event === 'land-gate-retry')).toBe(true);
  });

  test('single sink short-circuits: red gate refuses without bisect events', async () => {
    const h = closedHarness(['a'], (argv, cwd) =>
      argv[0] === 'test-a' && cwd.startsWith('land:')
        ? { output: 'red', exitCode: 1 }
        : { output: '', exitCode: 0 },
    );
    const plan = sinkPlan({ a: 'test-a' });

    await expect(landPlan(plan, h.deps, OPTS)).rejects.toThrow(LandBlockedError);
    expect(h.journal.some((e) => e.event === 'land-bisect')).toBe(false);
    expect(h.journal.some((e) => e.event === 'land-culprit')).toBe(true);
    expect(h.log.of('land').length).toBe(0);
  });

  test('incoherent diagnosis: the culprit-free subset also fails — integrity event, nothing lands', async () => {
    // test-b red on EVERY land stack (even solo) AND test-a red whenever
    // node/b is present: bisect blames b, but the b-free recheck still fails
    // test-b?? No — b-free stacks lack test-b's owner yet the gate union still
    // runs test-b... the union comes from the PLAN, so test-b runs on the
    // recheck too and stays red: the diagnosis cannot be coherent. Say so.
    const h = closedHarness(['a', 'b'], (argv, cwd) =>
      argv[0] === 'test-b' && cwd.startsWith('land:')
        ? { output: 'red everywhere', exitCode: 1 }
        : { output: '', exitCode: 0 },
    );
    const plan = sinkPlan({ a: 'test-a', b: 'test-b' });

    await expect(landPlan(plan, h.deps, OPTS)).rejects.toThrow(LandBlockedError);
    expect(h.log.of('land').length).toBe(0);
    expect(
      h.journal.some((e) => e.event === 'land-integrity-failed' || e.event === 'land-culprit'),
    ).toBe(true);
  });
});

// ── §A field gap (decker wave 1, ledger D9): the stack needs provisioning ────
// Work worktrees get node.setup post-isolate; the land-gate stack got NOTHING,
// so dep-needing smokes read red on a green composition and the bisect named
// innocent sinks. The gate now runs the SINKS' OWN setup union (deduped, exact
// string) in the stack before their smokes; a setup failure refuses the land
// as an ENVIRONMENT failure — it never enters the bisect as a culprit.
describe('the land gate provisions its stack (D9)', () => {
  function provisionedPlan(setups: { a: string; b: string }) {
    return PlanSchema.parse({
      goal: 'g',
      source: 's',
      nodes: [
        { id: 'a', work: { command: 'build-a' }, setup: setups.a, accept: { smoke: 'test-a' } },
        { id: 'b', work: { command: 'build-b' }, setup: setups.b, accept: { smoke: 'test-b' } },
      ],
    });
  }

  test("sinks' setups run in the stack, deduped, BEFORE any smoke", async () => {
    const stackCalls: string[] = [];
    const h = closedHarness(['a', 'b'], (argv, cwd) => {
      if (cwd.startsWith('land:')) stackCalls.push(argv.join(' '));
      return { output: '', exitCode: 0 };
    });
    const plan = provisionedPlan({ a: 'install-deps', b: 'install-deps' });

    const summary = await landPlan(plan, h.deps, OPTS);

    expect(summary.landed.sort()).toEqual(['a', 'b']);
    expect(stackCalls.filter((c) => c === 'install-deps').length).toBe(1); // deduped
    const firstSmoke = stackCalls.findIndex((c) => /^test-/.test(c));
    expect(stackCalls.indexOf('install-deps')).toBeLessThan(firstSmoke);
    const setupEvent = h.journal.find((e) => e.event === 'land-setup');
    expect(setupEvent?.commands).toEqual(['install-deps']);
  });

  test('a setup failure refuses as ENVIRONMENT — no bisect, no culprit named', async () => {
    const h = closedHarness(['a', 'b'], (argv, cwd) => {
      if (cwd.startsWith('land:') && argv[0] === 'install-deps') {
        return { output: 'npm ERR! registry down', exitCode: 1 };
      }
      return { output: '', exitCode: 0 };
    });
    const plan = provisionedPlan({ a: 'install-deps', b: 'install-deps' });

    await expect(landPlan(plan, h.deps, OPTS)).rejects.toThrow(LandBlockedError);
    const fail = h.journal.find((e) => e.event === 'land-setup-failed');
    expect(fail?.command).toBe('install-deps');
    expect(String(fail?.outputTail)).toContain('registry down');
    expect(h.journal.some((e) => e.event === 'land-culprit')).toBe(false);
    expect(h.journal.some((e) => e.event === 'land-bisect')).toBe(false);
    expect(h.git.refs.get('main')).toBeUndefined(); // nothing landed
  });

  test('bisect probes provision their own stacks too', async () => {
    // Interaction failure: test-a red only when both a and b are in the stack
    // AND deps are installed — every probe worktree must run the setup or the
    // diagnosis would be environment noise.
    const installedCwds = new Set<string>();
    const h = closedHarness(['a', 'b'], (argv, cwd) => {
      if (!cwd.startsWith('land:')) return { output: '', exitCode: 0 };
      if (argv[0] === 'install-deps') {
        installedCwds.add(cwd);
        return { output: '', exitCode: 0 };
      }
      if (!installedCwds.has(cwd)) return { output: 'missing deps', exitCode: 1 };
      if (argv[0] === 'test-a' && cwd.includes('node/a') && cwd.includes('node/b')) {
        return { output: 'interaction red', exitCode: 1 };
      }
      return { output: '', exitCode: 0 };
    });
    const plan = provisionedPlan({ a: 'install-deps', b: 'install-deps' });

    await expect(landPlan(plan, h.deps, OPTS)).rejects.toThrow(LandBlockedError);
    // Diagnosis stayed coherent: a culprit was named (not integrity-failed),
    // which is only possible if every probe stack was provisioned.
    expect(h.journal.some((e) => e.event === 'land-culprit')).toBe(true);
    expect(h.journal.some((e) => e.event === 'land-integrity-failed')).toBe(false);
    expect(installedCwds.size).toBeGreaterThan(1); // full stack + probe stacks
  });
});
