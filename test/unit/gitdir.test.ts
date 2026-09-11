/**
 * Unit: the git dir pleach stores its state under is absolute whatever shape
 * the repo root was given in (ledger D22, jahala/pleach#102). Real repos in
 * tmp dirs, no mocks.
 *
 * `--repo-root .` is the documented way to run, and in a plain clone it gave
 * `.git` — a relative git dir. The worktree base is derived from it, and the
 * isolate seam runs every git command as `git -C <path>` with `cwd: <path>`:
 * a relative path is resolved once by the cwd and again by `-C` from inside
 * the worktree, where `.git` is a file — ENOTDIR on the first `git status`
 * after the worker stops. A linked worktree masked it: its `.git` file
 * carries an absolute pointer, so every conducted run on a Conductor
 * workspace saw an absolute git dir and never the defect.
 */
import { expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { resolveGitDir } from '../../src/seams/gitdir.ts';
import { createRepo, gitIn } from '../support/git-repo.ts';

test('a plain clone named by a relative root resolves to an absolute git dir', async () => {
  const { path: repo, cleanup } = await createRepo();
  try {
    const rel = relative(process.cwd(), repo);
    expect(isAbsolute(rel)).toBe(false);

    const gitDir = resolveGitDir(rel);

    expect(isAbsolute(gitDir)).toBe(true);
    expect(gitDir).toBe(join(repo, '.git'));
  } finally {
    await cleanup();
  }
});

test('a linked worktree named by a relative root resolves to an absolute git dir', async () => {
  const { path: repo, cleanup } = await createRepo();
  const wtParent = await mkdtemp(join(tmpdir(), 'pleach-gitdir-wt-'));
  const wt = join(wtParent, 'wt');
  try {
    await gitIn(repo, 'worktree', 'add', '--detach', wt);
    const rel = relative(process.cwd(), wt);
    expect(isAbsolute(rel)).toBe(false);

    const gitDir = resolveGitDir(rel);

    expect(isAbsolute(gitDir)).toBe(true);
    // git writes the realpath into the worktree's pointer; tmp dirs are symlinked on macOS.
    expect(realpathSync(gitDir)).toBe(realpathSync(join(repo, '.git', 'worktrees', 'wt')));
  } finally {
    await gitIn(repo, 'worktree', 'remove', '--force', wt).catch(() => undefined);
    await rm(wtParent, { recursive: true, force: true });
    await cleanup();
  }
});
