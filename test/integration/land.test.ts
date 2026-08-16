// Integration: IsolateSeam.land against REAL git (ledger B3 — the last mile).
//
// land() builds the landing merge in a throwaway detached worktree and touches
// the user's checkout only via a final `merge --ff-only` — so a conflict, a
// detached HEAD, or a moved branch leaves the repo exactly as it was.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LandBlockedError, LandConflictError } from '../../src/core/errors.ts';
import { exec } from '../../src/seams/exec.ts';
import { createIsolateSeam } from '../../src/seams/isolate.ts';
import { createRepo, execLocal, gitIn } from '../support/git-repo.ts';

describe('isolate seam — land', () => {
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

  async function resolveDefault(): Promise<string> {
    return gitIn(repo, 'symbolic-ref', '--short', 'HEAD');
  }

  // Commit a file on a node branch (from the default branch tip) and return to
  // the default branch untouched — how run-plan leaves node/<id> branches.
  async function nodeBranch(name: string, file: string, contents: string): Promise<string> {
    const defaultBranch = await resolveDefault();
    const base = await gitIn(repo, 'rev-parse', 'HEAD');
    await gitIn(repo, 'checkout', '--detach', base);
    await writeFile(join(repo, file), contents);
    await gitIn(repo, 'add', file);
    await gitIn(repo, 'commit', '-m', `node ${name}`);
    const sha = await gitIn(repo, 'rev-parse', 'HEAD');
    await gitIn(repo, 'branch', '-f', name, sha);
    await gitIn(repo, 'checkout', defaultBranch);
    return sha;
  }

  test('a single sink fast-forwards the checked-out branch to the sink tip', async () => {
    const branch = await resolveDefault();
    const sha = await nodeBranch('node/one', 'one.txt', 'one\n');
    const seam = createIsolateSeam(exec, repo);

    const landed = await seam.land(repo, ['node/one']);

    expect(landed.branch).toBe(branch);
    expect(landed.sha).toBe(sha);
    expect(await gitIn(repo, 'rev-parse', 'HEAD')).toBe(sha);
    expect(await gitIn(repo, 'show', 'HEAD:one.txt')).toBe('one');
    // No worktree left behind.
    const wt = await gitIn(repo, 'worktree', 'list');
    expect(wt.split('\n').length).toBe(1);
  });

  test('two compatible sinks land as merges; both files reach the branch', async () => {
    await resolveDefault();
    await nodeBranch('node/a', 'a.txt', 'a\n');
    await nodeBranch('node/b', 'b.txt', 'b\n');
    const seam = createIsolateSeam(exec, repo);

    const landed = await seam.land(repo, ['node/a', 'node/b']);

    expect(await gitIn(repo, 'rev-parse', 'HEAD')).toBe(landed.sha);
    expect(await gitIn(repo, 'show', 'HEAD:a.txt')).toBe('a');
    expect(await gitIn(repo, 'show', 'HEAD:b.txt')).toBe('b');
  });

  test('conflicting sinks refuse to land and leave the repo untouched', async () => {
    await resolveDefault();
    await nodeBranch('node/a', 'same.txt', 'version a\n');
    await nodeBranch('node/b', 'same.txt', 'version b\n');
    const before = await gitIn(repo, 'rev-parse', 'HEAD');
    const seam = createIsolateSeam(exec, repo);

    await expect(seam.land(repo, ['node/a', 'node/b'])).rejects.toBeInstanceOf(LandConflictError);

    // Branch tip unmoved, no merge in progress, no leaked worktree.
    expect(await gitIn(repo, 'rev-parse', 'HEAD')).toBe(before);
    const status = await execLocal(['git', '-C', repo, 'status', '--porcelain'], repo);
    expect(status.output.trim()).toBe('');
    const wt = await gitIn(repo, 'worktree', 'list');
    expect(wt.split('\n').length).toBe(1);
  });

  test('the conflict error names the files', async () => {
    await resolveDefault();
    await nodeBranch('node/a', 'same.txt', 'version a\n');
    await nodeBranch('node/b', 'same.txt', 'version b\n');
    const seam = createIsolateSeam(exec, repo);

    try {
      await seam.land(repo, ['node/a', 'node/b']);
      throw new Error('expected LandConflictError');
    } catch (err) {
      if (!(err instanceof LandConflictError)) throw err;
      expect(err.files).toEqual(['same.txt']);
    }
  });

  test('a detached HEAD refuses to land — nowhere to land onto', async () => {
    await resolveDefault();
    await nodeBranch('node/one', 'one.txt', 'one\n');
    await gitIn(repo, 'checkout', '--detach', 'HEAD');
    const seam = createIsolateSeam(exec, repo);

    await expect(seam.land(repo, ['node/one'])).rejects.toBeInstanceOf(LandBlockedError);
  });

  test('an uncommitted overlapping change blocks the fast-forward and survives', async () => {
    await resolveDefault();
    await nodeBranch('node/one', 'init.txt', 'landed version\n');
    // Dirty the SAME file in the user checkout — ff must refuse, edit must survive.
    await writeFile(join(repo, 'init.txt'), 'local uncommitted edit\n');
    const before = await gitIn(repo, 'rev-parse', 'HEAD');
    const seam = createIsolateSeam(exec, repo);

    await expect(seam.land(repo, ['node/one'])).rejects.toBeInstanceOf(LandBlockedError);

    expect(await gitIn(repo, 'rev-parse', 'HEAD')).toBe(before);
    const contents = await Bun.file(join(repo, 'init.txt')).text();
    expect(contents).toBe('local uncommitted edit\n');
  });

  test('re-landing an already-landed sink is a no-op', async () => {
    await resolveDefault();
    const sha = await nodeBranch('node/one', 'one.txt', 'one\n');
    const seam = createIsolateSeam(exec, repo);

    await seam.land(repo, ['node/one']);
    const again = await seam.land(repo, ['node/one']);

    expect(again.sha).toBe(sha);
    expect(await gitIn(repo, 'rev-parse', 'HEAD')).toBe(sha);
  });
});
