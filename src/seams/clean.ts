// The aftermath sweeps (D12): a killed conductor leaves a registered worktree
// and a lock file behind. Locks self-heal on the next run (stale takeover);
// these sweeps let `pleach clean` heal them on demand — deterministically,
// touching ONLY what pleach provably owns. Worker sessions are umbel's
// jurisdiction and are deliberately not touched here.
import { readdir, realpath, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExecFn } from '../loop/deps.ts';
import { resolveGitDir } from './gitdir.ts';
import { isAlive, readPid } from './lock.ts';

// <git-dir>/pleach-<12 hex>.lock — dead holder → unlink; live holder →
// reported, never touched (a live lock means a run may be in flight).
export async function sweepStaleLocks(
  repoRoot: string,
): Promise<{ removed: string[]; live: string[] }> {
  const gitDir = resolveGitDir(repoRoot);
  const removed: string[] = [];
  const live: string[] = [];
  // Total: a non-repo (no git dir) simply has nothing to sweep.
  const entries = await readdir(gitDir).catch(() => [] as string[]);
  for (const name of entries) {
    if (!/^pleach-[0-9a-f]{12}\.lock$/.test(name)) continue;
    const path = join(gitDir, name);
    const pid = await readPid(path);
    if (pid !== null && isAlive(pid)) {
      live.push(path);
      continue;
    }
    await unlink(path);
    removed.push(path);
  }
  return { removed: removed.sort(), live: live.sort() };
}

// Worktrees pleach owns: under <git-dir>/pleach/worktrees/ (the current home)
// or the legacy mkdtemp shape <os-tmpdir>/pleach-*/wt — ANCHORED to the OS
// temp dir, because a bare /pleach-*/wt suffix would also match a human's
// checkout that happens to live in a directory named pleach-something.
// Removal goes through git (never a bare rm of a checkout); the mkdtemp base
// dir — provably pleach-created by the same match — is cleared after. Ends
// with a prune so entries whose directories vanished (the temp reaper) clear too.
// The ownership decision, pure: current-home prefix, or the legacy mkdtemp
// shape ANCHORED under the OS temp dir. Exported for its unit tests — this
// predicate is the only thing standing between the sweep and a human's
// checkout that happens to live in a directory named pleach-something.
export function ownsWorktree(path: string, ownBase: string, tmpBase: string): boolean {
  if (path.startsWith(ownBase)) return true;
  return path.startsWith(tmpBase) && /\/pleach-[^/]+\/wt$/.test(path);
}

export async function sweepOrphanWorktrees(exec: ExecFn, repoRoot: string): Promise<string[]> {
  // git lists canonical paths (macOS: /private/var/…); canonicalize our side
  // too or the ownership prefix never matches under /var → /private/var.
  const rootReal = await realpath(repoRoot).catch(() => repoRoot);
  const ownBase = join(resolveGitDir(rootReal), 'pleach', 'worktrees');
  const tmpReal = await realpath(tmpdir()).catch(() => tmpdir());
  const list = await exec(['git', '-C', repoRoot, 'worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
  });
  const paths = list.output
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));

  const removed: string[] = [];
  for (const p of paths) {
    if (!ownsWorktree(p, ownBase, tmpReal)) continue;
    const r = await exec(['git', '-C', repoRoot, 'worktree', 'remove', '--force', p], {
      cwd: repoRoot,
    });
    if (r.exitCode === 0) {
      removed.push(p);
      await rm(dirname(p), { recursive: true, force: true });
    }
  }
  await exec(['git', '-C', repoRoot, 'worktree', 'prune'], { cwd: repoRoot });
  return removed.sort();
}
