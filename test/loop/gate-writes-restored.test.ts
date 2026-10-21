// ledger: #131 — a failed gate's writes are inherited by the retry. A smoke
// gate that rewrites a page with `[!]` marks and goes red must not hand those
// marks to the worker retry: the loop records the tree before the gate, rewinds
// it on a red (the D10 gate-only retry included), journals `gate-writes-restored`
// with the restored path, and the published tree never carries the mark.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { makeHarness } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };

describe('a failed gate never edits what the retry starts from (#131)', () => {
  test('a smoke gate that writes a mark and fails is rewound before the worker retry; the published tree is clean', async () => {
    let runs = 0;
    const h = makeHarness({
      changedByNode: { x: ['page.md'] },
      worktreeContentByNode: { x: { 'page.md': '[x] done\n' } },
      execScript: (argv, cwd, git) => {
        if (argv[0] === 'smokey') {
          runs += 1;
          if (runs <= 2) {
            // The gate rewrites a check's line from `[x]` to `[!]`, then red.
            const wt = new Map(git.worktree.get(cwd) ?? []);
            wt.set('page.md', `${wt.get('page.md') ?? ''}[!] `);
            git.worktree.set(cwd, wt);
            return { output: 'flaky check', exitCode: 1 };
          }
          return { output: '', exitCode: 0 };
        }
        return { output: '', exitCode: 0 };
      },
    });

    const plan = PlanSchema.parse({
      goal: 'g',
      source: 's',
      nodes: [
        {
          id: 'x',
          work: { prompt: 'build x' },
          accept: { smoke: 'smokey' },
          policy: { maxAttempts: 2 },
        },
      ],
    });

    const summary = await runPlan(plan, h.deps, OPTS);

    expect(summary.closed).toEqual(['x']);
    // Attempt 1's two red smoke runs were each rewound, so the gate named the
    // restored path both times (the D10 gate-only retry and the final red).
    const restored = h.journal.filter((e) => e.event === 'gate-writes-restored');
    expect(restored.length).toBe(2);
    for (const r of restored) {
      expect(r.node).toBe('x');
      expect(r.gate).toBe('smoke');
      expect(r.paths).toEqual(['page.md']);
      expect(r.count).toBe(1);
    }

    // The published node/<id> tree carries the worker's `[x]`, never the gate's
    // `[!]`.
    const sha = h.git.refs.get('node/x');
    expect(sha).toBeDefined();
    expect(h.git.commitTrees.get(sha as string)?.get('page.md')).toBe('[x] done\n');
  });
});
