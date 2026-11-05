import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Where node worktrees and land stacks live (issue #174). A gate must check the
// same rules wherever it runs, and tools like Biome turn their React rules off
// for any path under `.git/` — so a worktree under `<git-dir>/pleach/worktrees/`
// gets a weaker gate than the branch does. The home is therefore OUTSIDE `.git/`.
//
// This function is pure: it is handed the env values, the home dir and the
// repo's identifying facts as data, and it computes one directory per
// repository under a shared base. The seam (src/seams/worktree-home.ts) reads
// `process.env`, `os.homedir()` and `realpath`, then calls it, so isolate and
// clean share one home for the rule.

export interface WorktreeHomeInput {
  // $PLEACH_WORKTREE_HOME — the explicit override; the whole base, not a parent.
  worktreeHome?: string;
  // $XDG_CACHE_HOME — the cache base when no override is set.
  xdgCacheHome?: string;
  // os.homedir() — the fallback base when neither is set.
  homeDir: string;
  // basename of the repo root — names the repository's directory.
  repoName: string;
  // realpath of the common git dir — the repository's stable identity.
  gitDirReal: string;
}

// One directory per repository: <basename of the repo root>-<first 12 hex of
// sha256 of the realpath of the common git dir>. The hash keeps two checkouts
// that happen to share a basename apart.
export function worktreeHome(input: WorktreeHomeInput): string {
  const base =
    input.worktreeHome ??
    join(input.xdgCacheHome ?? join(input.homeDir, '.cache'), 'pleach', 'worktrees');
  const digest = createHash('sha256').update(input.gitDirReal).digest('hex').slice(0, 12);
  return join(base, `${input.repoName}-${digest}`);
}
