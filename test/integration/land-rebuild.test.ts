// issue #116 — a land conflict pins the conflicting sink instead of telling
// the operator to merge by hand. Integration against REAL git: `landPlan`
// builds the sink stack, and when the second sink conflicts it refuses, names
// it, and leaves `refs/pleach/rebuild/<id>` at the stack commit (the target
// tip plus the sinks merged before it) so the next run can rebuild on it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LandConflictError } from '../../src/core/errors.ts';
import { PlanSchema } from '../../src/core/plan.ts';
import { landPlan } from '../../src/loop/land.ts';
import { exec } from '../../src/seams/exec.ts';
import { createIsolateSeam } from '../../src/seams/isolate.ts';
import { makeHarness } from '../loop/harness.ts';
import { createRepo, gitIn } from '../support/git-repo.ts';

const SOURCE = 'integration-land-rebuild';

describe('landPlan pins a conflict for rebuild (issue #116)', () => {
  let repo = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanup = r.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  // Commit files on a node branch from the default branch tip, then return the
  // checkout to the default branch untouched — how run-plan leaves node/<id>.
  async function nodeBranch(name: string, files: Record<string, string>): Promise<string> {
    const defaultBranch = await gitIn(repo, 'symbolic-ref', '--short', 'HEAD');
    const base = await gitIn(repo, 'rev-parse', 'HEAD');
    await gitIn(repo, 'checkout', '--detach', base);
    for (const [file, contents] of Object.entries(files)) {
      await writeFile(join(repo, file), contents);
    }
    await gitIn(repo, 'add', '-A');
    await gitIn(repo, 'commit', '-m', `node ${name}`);
    const sha = await gitIn(repo, 'rev-parse', 'HEAD');
    await gitIn(repo, 'branch', '-f', name, sha);
    await gitIn(repo, 'checkout', defaultBranch);
    return sha;
  }

  test('a conflicting sink is refused by name, pinned at the stack commit, and the branch is untouched', async () => {
    const shaA = await nodeBranch('node/a', { 'a.txt': 'a\n', 'same.txt': 'version a\n' });
    const shaB = await nodeBranch('node/b', { 'b.txt': 'b\n', 'same.txt': 'version b\n' });
    const before = await gitIn(repo, 'rev-parse', 'HEAD');

    const h = makeHarness({
      closed: new Map([
        ['a', shaA],
        ['b', shaB],
      ]),
    });
    const deps = { ...h.deps, isolate: createIsolateSeam(exec, repo) };
    const plan = PlanSchema.parse({
      goal: 'two sibling sinks conflict on the same file',
      source: SOURCE,
      nodes: [
        { id: 'a', work: { command: 'true' } },
        { id: 'b', work: { command: 'true' } },
      ],
    });

    let caught: unknown;
    try {
      await landPlan(plan, deps, { repoRoot: repo });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LandConflictError);
    const err = caught as LandConflictError;
    expect(err.ref).toBe('node/b');
    expect(err.files).toEqual(['same.txt']);

    // The journal names the node, the stack commit it is pinned at, and the ref.
    const conflict = h.journal.find((e) => e.event === 'land-conflict');
    expect(conflict).toMatchObject({
      node: 'b',
      files: ['same.txt'],
      rebuildRef: 'refs/pleach/rebuild/b',
    });
    const stackSha = conflict?.stackSha as string;
    expect(stackSha).toMatch(/^[0-9a-f]{40}$/);

    // The ref points at the stack commit: the target tip plus A, and not B.
    expect(await gitIn(repo, 'rev-parse', 'refs/pleach/rebuild/b')).toBe(stackSha);
    expect(await gitIn(repo, 'show', `${stackSha}:same.txt`)).toBe('version a');
    expect(await gitIn(repo, 'show', `${stackSha}:a.txt`)).toBe('a');

    // The target branch has not moved, and no worktree leaked.
    expect(await gitIn(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect((await gitIn(repo, 'worktree', 'list')).split('\n').length).toBe(1);
  });
});
