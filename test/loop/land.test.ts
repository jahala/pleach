// Loop: landPlan — the policy layer over IsolateSeam.land (ledger B3).
//
// The loop decides WHAT may land (every plan node verified-closed, sinks
// resolved through the B1/C5 baseRef chain) and journals the outcome; the git
// mechanics live in the seam. In-memory seams per the testing doctrine.
import { describe, expect, test } from 'bun:test';
import { LandBlockedError, RebuildRequiredError } from '../../src/core/errors.ts';
import { PlanSchema } from '../../src/core/plan.ts';
import { landPlan } from '../../src/loop/land.ts';
import { makeHarness } from './harness.ts';

function plan(nodes: { id: string; needs?: string[] }[]) {
  return PlanSchema.parse({
    goal: 'land it',
    source: 'polyglot.html',
    nodes: nodes.map((n) => ({ id: n.id, work: { command: 'true' }, needs: n.needs ?? [] })),
  });
}

const OPTS = { repoRoot: '/repo' };

describe('landPlan', () => {
  test('refuses when any plan node is not closed, naming the unverified nodes', async () => {
    const p = plan([{ id: 'a' }, { id: 'b', needs: ['a'] }]);
    const h = makeHarness({ closed: new Map([['a', 'sha-a']]) });

    await expect(landPlan(p, h.deps, OPTS)).rejects.toBeInstanceOf(LandBlockedError);
    await expect(landPlan(p, h.deps, OPTS)).rejects.toThrow('b');
    // Nothing reached the seam.
    expect(h.log.count('land')).toBe(0);
  });

  test('lands the sink of a fully-closed chain via its pinned SHA', async () => {
    const p = plan([{ id: 'a' }, { id: 'b', needs: ['a'] }]);
    const h = makeHarness({
      closed: new Map([
        ['a', 'sha-a'],
        ['b', 'sha-b'],
      ]),
      refs: { 'node/a': 'sha-a', 'node/b': 'sha-b', 'sha-a': 'sha-a', 'sha-b': 'sha-b' },
    });

    const summary = await landPlan(p, h.deps, OPTS);

    expect(summary.landed).toEqual(['b']);
    expect(summary.branch).toBe('main');
    // The seam received exactly the sink's resolved ref.
    const landEvents = h.log.of('land');
    expect(landEvents.length).toBe(1);
    expect(landEvents[0]?.detail).toBe('node/b');
  });

  test('a ledger-closed set implies ancestors (seeded closure) — only the sink lands', async () => {
    // tend closed only the integration node; its steps are contained in it.
    const p = plan([{ id: 's1' }, { id: 's2' }, { id: 'it', needs: ['s1', 's2'] }]);
    const h = makeHarness({
      closed: new Map([['it', 'sha-it']]),
      refs: { 'node/it': 'sha-it', 'sha-it': 'sha-it' },
    });

    const summary = await landPlan(p, h.deps, OPTS);

    expect(summary.landed).toEqual(['it']);
  });

  test('a sink whose branch and SHA are both gone is a rebuild, not a land', async () => {
    const p = plan([{ id: 'a' }]);
    const h = makeHarness({ closed: new Map([['a', 'sha-gone']]) }); // no refs seeded

    await expect(landPlan(p, h.deps, OPTS)).rejects.toBeInstanceOf(RebuildRequiredError);
    expect(h.log.count('land')).toBe(0);
  });

  test('a force-moved node branch (SHA mismatch) refuses to land (C5)', async () => {
    const p = plan([{ id: 'a' }]);
    const h = makeHarness({
      closed: new Map([['a', 'sha-recorded']]),
      refs: { 'node/a': 'sha-tampered' },
    });

    await expect(landPlan(p, h.deps, OPTS)).rejects.toBeInstanceOf(RebuildRequiredError);
    expect(h.log.count('land')).toBe(0);
  });

  test('journals land-start and landed; holds the lock across the land', async () => {
    const p = plan([{ id: 'a' }]);
    const h = makeHarness({
      closed: new Map([['a', 'sha-a']]),
      refs: { 'node/a': 'sha-a' },
    });

    await landPlan(p, h.deps, OPTS);

    const events = h.journal.map((e) => e.event);
    expect(events).toContain('land-start');
    expect(events).toContain('landed');
    expect(h.log.first('lock.acquire')).toBeLessThan(h.log.first('land'));
    expect(h.log.first('land')).toBeLessThan(h.log.first('lock.release'));
  });

  test('a seam conflict is journaled and the lock still releases', async () => {
    const p = plan([{ id: 'a' }]);
    const { LandConflictError } = await import('../../src/core/errors.ts');
    const h = makeHarness({
      closed: new Map([['a', 'sha-a']]),
      refs: { 'node/a': 'sha-a' },
      landThrows: new LandConflictError('node/a', ['same.txt']),
    });

    await expect(landPlan(p, h.deps, OPTS)).rejects.toBeInstanceOf(LandConflictError);

    const conflict = h.journal.find((e) => e.event === 'land-conflict');
    expect(conflict?.files).toEqual(['same.txt']);
    expect(h.log.count('lock.release')).toBe(1);
  });

  test('multiple sinks land in plan order', async () => {
    const p = plan([{ id: 'a' }, { id: 'b' }]);
    const h = makeHarness({
      closed: new Map([
        ['a', 'sha-a'],
        ['b', 'sha-b'],
      ]),
      refs: { 'node/a': 'sha-a', 'node/b': 'sha-b' },
    });

    const summary = await landPlan(p, h.deps, OPTS);

    expect(summary.landed).toEqual(['a', 'b']);
    expect(h.log.of('land')[0]?.detail).toBe('node/a,node/b');
  });
});
