// Integration: IsolateSeam.landStack against REAL git — a merge the repository's
// own hook refuses (ledger D21), not a merge that conflicts (ledger B3).
//
// When the checked-out branch has moved past the node branch's base, landing
// must create a real merge commit, which runs the repository's hooks. A hook
// that refuses (`commit-msg` via `core.hooksPath`) makes `git merge` exit
// non-zero with NO unmerged files — a refusal, not a conflict. The seam must
// say so, and never report "conflicts in: <nothing>".
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LandConflictError, LandMergeRefusedError } from '../../src/core/errors.ts';
import { exec } from '../../src/seams/exec.ts';
import { createIsolateSeam } from '../../src/seams/isolate.ts';
import { createRepo, gitIn } from '../support/git-repo.ts';

async function land(
  seam: ReturnType<typeof createIsolateSeam>,
  root: string,
  refs: readonly string[],
): Promise<{ branch: string; sha: string }> {
  const stack = await seam.landStack(root, refs);
  try {
    return await stack.publish();
  } finally {
    await stack.dispose();
  }
}

describe('isolate seam — land, a hook-refused merge', () => {
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

  // ledger: D28 — a merge git refuses without a conflict is a refusal, never a conflict.
  test('a commit-msg hook that refuses is a refusal, not a conflict naming no files', async () => {
    const branch = await gitIn(repo, 'symbolic-ref', '--short', 'HEAD');
    const base = await gitIn(repo, 'rev-parse', 'HEAD');

    // A node branch based on the OLD base — where it stays.
    await gitIn(repo, 'checkout', '--detach', base);
    await writeFile(join(repo, 'other.txt'), 'other\n');
    await gitIn(repo, 'add', 'other.txt');
    await gitIn(repo, 'commit', '-m', 'node one');
    const nodeSha = await gitIn(repo, 'rev-parse', 'HEAD');
    await gitIn(repo, 'branch', '-f', 'node/one', nodeSha);
    await gitIn(repo, 'checkout', branch);

    // The checked-out branch moves one commit past the base, touching OTHER
    // files — so the merge is real (a merge commit) but conflict-free.
    await writeFile(join(repo, 'move.txt'), 'moved\n');
    await gitIn(repo, 'add', 'move.txt');
    await gitIn(repo, 'commit', '-m', 'branch moved past base');

    // A committed commit-msg hook that refuses every message, reached through
    // a relative core.hooksPath (so it runs in every worktree pleach makes).
    const hooks = join(repo, '.githooks');
    await mkdir(hooks);
    await writeFile(
      join(hooks, 'commit-msg'),
      '#!/bin/sh\necho "house rule: no merges from this tree" >&2\nexit 1\n',
    );
    await chmod(join(hooks, 'commit-msg'), 0o755);
    await gitIn(repo, 'add', '.githooks/commit-msg');
    await gitIn(repo, 'commit', '-m', 'the house hook');
    await gitIn(repo, 'config', 'core.hooksPath', '.githooks');

    const before = await gitIn(repo, 'rev-parse', 'HEAD');
    const seam = createIsolateSeam(exec, repo);

    let caught: unknown;
    try {
      await land(seam, repo, ['node/one']);
      throw new Error('expected a refusal');
    } catch (err) {
      caught = err;
    }

    // The merge resolved; git refused to record it. That is never a conflict,
    // and certainly not one naming no files (the empty list is the bug).
    expect(caught).not.toBeInstanceOf(LandConflictError);
    expect(caught).toBeInstanceOf(LandMergeRefusedError);
    const refused = caught as LandMergeRefusedError;
    expect(refused.ref).toBe('node/one');
    expect(refused.message).toContain('node/one');
    expect(refused.message).toContain('refused');
    expect(refused.message).not.toContain('conflicts in');
    expect(refused.output).toContain('house rule: no merges from this tree');

    // The checkout is untouched and no worktree is left behind.
    expect(await gitIn(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect((await gitIn(repo, 'worktree', 'list')).split('\n').length).toBe(1);
  });
});
