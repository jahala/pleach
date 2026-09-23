/**
 * Integration: parallel nodes isolate together (ledger D27). Real git repos
 * in tmp dirs, the real isolate seam — no mocks.
 *
 * A run isolates its ready nodes concurrently. `git worktree add` reads every
 * registered worktree's admin dir while it registers its own, and one that
 * another add has half-written makes it fail ("failed to read
 * .git/worktrees/wt/commondir"). A node then failed at `isolate HEAD` before
 * it had a tree. The seam creates one worktree at a time.
 */
import { expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { exec } from '../../src/seams/exec.ts';
import { createIsolateSeam } from '../../src/seams/isolate.ts';
import { createRepo } from '../support/git-repo.ts';

const NODES = PlanSchema.parse({
  goal: 'parallel nodes isolate together',
  source: 'isolate-concurrent',
  nodes: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, work: { command: 'true' } })),
}).nodes;

const ROUNDS = 25;

// ledger: D27 — every one of eight concurrent isolates in a fresh repo succeeds.
test('eight nodes isolating at once in a fresh repository all get a tree', async () => {
  const failures: string[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const repo = await createRepo();
    try {
      const seam = createIsolateSeam(exec, repo.path);
      const results = await Promise.allSettled(NODES.map((node) => seam.isolate(node, ['HEAD'])));
      for (const r of results) {
        if (r.status === 'rejected') failures.push(String(r.reason));
        else await r.value.dispose();
      }
    } finally {
      await repo.cleanup();
    }
  }
  expect(failures).toEqual([]);
}, 180_000);
