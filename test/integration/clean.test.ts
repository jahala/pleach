/**
 * Integration: the aftermath sweeps (bandung's dogfood P5, ledger D12) and the
 * worktree relocation that makes orphans findable. Real git repos, no mocks.
 *
 * A killed run used to leave three things behind: the temp worktree entry, the
 * lock file, and a live worker session. Sessions are umbel's; the other two
 * are pleach's to sweep — and worktrees now live under
 * <git-dir>/pleach/worktrees/ so ownership is unambiguous and the OS temp
 * reaper never eats a live run's tree.
 */
import { expect, test } from 'bun:test';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecFn } from '../../src/loop/deps.ts';
import { ownsWorktree, sweepOrphanWorktrees, sweepStaleLocks } from '../../src/seams/clean.ts';
import { exec as execLocalSeam } from '../../src/seams/exec.ts';
import { resolveGitDir } from '../../src/seams/gitdir.ts';
import { createIsolateSeam } from '../../src/seams/isolate.ts';
import { createRepo, execLocal, gitIn } from '../support/git-repo.ts';

const exec: ExecFn = (argv, opts) => execLocal(argv as string[], opts.cwd);

test('isolate worktrees live under <git-dir>/pleach/worktrees — not the OS temp dir', async () => {
  const { path: repo, cleanup } = await createRepo();
  try {
    const seam = createIsolateSeam(exec, repo);
    const iso = await seam.isolate({ id: 'x' } as Parameters<typeof seam.isolate>[0], ['HEAD']);
    expect(iso.cwd.startsWith(join(resolveGitDir(repo), 'pleach', 'worktrees'))).toBe(true);
    await iso.dispose();
  } finally {
    await cleanup();
  }
});

test('sweepStaleLocks removes dead-pid locks, keeps live ones, and reports the live holder', async () => {
  const { path: repo, cleanup } = await createRepo();
  try {
    const gitDir = resolveGitDir(repo);
    const stale = join(gitDir, 'pleach-aaaaaaaaaaaa.lock');
    const live = join(gitDir, 'pleach-bbbbbbbbbbbb.lock');
    await writeFile(stale, '999999', 'utf8'); // beyond macOS pid_max — provably dead
    await writeFile(live, String(process.pid), 'utf8'); // this test process — provably live

    const result = await sweepStaleLocks(repo);

    expect(result.removed).toEqual([stale]);
    expect(result.live).toEqual([live]);
    expect(await readFile(live, 'utf8')).toBe(String(process.pid)); // untouched
  } finally {
    await cleanup();
  }
});

// ledger: D18 — the landing's lock is a lock too. A killed landing leaves
// `<lock>.land` behind and `pleach clean` must heal it the same way; a live one
// is reported, never touched. The drain marker beside them is not a lock and
// carries no pid — a sweep that ate it would stop the next run before it began.
test("sweepStaleLocks heals a dead landing's lock and leaves the drain marker", async () => {
  const { path: repo, cleanup } = await createRepo();
  try {
    const gitDir = resolveGitDir(repo);
    const stale = join(gitDir, 'pleach-aaaaaaaaaaaa.lock.land');
    const live = join(gitDir, 'pleach-bbbbbbbbbbbb.lock.land');
    const marker = join(gitDir, 'pleach-aaaaaaaaaaaa.lock.stop');
    await writeFile(stale, '999999', 'utf8'); // beyond macOS pid_max — provably dead
    await writeFile(live, String(process.pid), 'utf8'); // this test process — provably live
    await writeFile(marker, '', 'utf8');

    const result = await sweepStaleLocks(repo);

    expect(result.removed).toEqual([stale]);
    expect(result.live).toEqual([live]);
    expect(await readFile(marker, 'utf8')).toBe('');
  } finally {
    await cleanup();
  }
});

test('sweepOrphanWorktrees disposes pleach-owned worktrees and prunes vanished entries', async () => {
  const { path: repo, cleanup } = await createRepo();
  try {
    // An orphan exactly as a killed run leaves it: registered, pleach-owned.
    const seam = createIsolateSeam(exec, repo);
    const iso = await seam.isolate({ id: 'x' } as Parameters<typeof seam.isolate>[0], ['HEAD']);
    // No dispose — the run "died" here. Compare in git's canonical view
    // (macOS reports /private/var/… for /var/… paths).
    const cwdReal = await realpath(iso.cwd);
    const before = await gitIn(repo, 'worktree', 'list', '--porcelain');
    expect(before).toContain(cwdReal);

    const removed = await sweepOrphanWorktrees(exec, repo);

    expect(removed).toContain(cwdReal);
    const after = await gitIn(repo, 'worktree', 'list', '--porcelain');
    expect(after).not.toContain(cwdReal);
  } finally {
    await cleanup();
  }
});

test('sweepOrphanWorktrees never touches a worktree it does not own', async () => {
  const { path: repo, cleanup } = await createRepo();
  try {
    // A human's own worktree, outside pleach's namespace.
    const theirs = join(repo, '..', `theirs-${Date.now()}`);
    await gitIn(repo, 'worktree', 'add', '--detach', theirs, 'HEAD');

    const removed = await sweepOrphanWorktrees(exec, repo);

    expect(removed).toEqual([]);
    const list = await gitIn(repo, 'worktree', 'list', '--porcelain');
    expect(list).toContain('theirs-');
    await gitIn(repo, 'worktree', 'remove', '--force', theirs);
  } finally {
    await cleanup();
  }
});

test('the exec seam honors an abort signal — resolves promptly, non-zero, never throws', async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 100);
  const r = await execLocalSeam(['sleep', '10'], { cwd: '/tmp', signal: controller.signal });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(r.exitCode).not.toBe(0);
});

test('ownsWorktree — the predicate between the sweep and a human checkout', () => {
  const ownBase = '/repo/.git/pleach/worktrees';
  const tmp = '/private/var/folders/xx/T';
  // pleach's own homes:
  expect(ownsWorktree(`${ownBase}/wt-abc/wt`, ownBase, tmp)).toBe(true);
  expect(ownsWorktree(`${tmp}/pleach-abc123/wt`, ownBase, tmp)).toBe(true);
  expect(ownsWorktree(`${tmp}/pleach-land-abc/wt`, ownBase, tmp)).toBe(true);
  // a human's checkout that merely LOOKS pleach-ish:
  expect(ownsWorktree('/home/user/code/pleach-v1/wt', ownBase, tmp)).toBe(false); // outside tmp
  expect(ownsWorktree(`${tmp}/pleach-abc123/checkout`, ownBase, tmp)).toBe(false); // wrong suffix
  expect(ownsWorktree(`${tmp}/other-abc/wt`, ownBase, tmp)).toBe(false); // wrong prefix
});
