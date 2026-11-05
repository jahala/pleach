import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { worktreeHome } from '../core/worktree-home.ts';
import { resolveGitDir } from './gitdir.ts';

// The worktree home for a repository, computed once from the environment (issue
// #174): read `process.env` and `os.homedir()`, canonicalise the common git dir
// with `realpath`, and hand the facts to the pure core/worktree-home.ts. Both
// the isolate seam and the clean sweep call this, so there is one home for the
// rule.
export async function worktreeHomeFor(repoRoot: string): Promise<string> {
  const gitDir = resolveGitDir(repoRoot);
  const gitDirReal = await realpath(gitDir).catch(() => gitDir);
  return worktreeHome({
    worktreeHome: process.env.PLEACH_WORKTREE_HOME,
    xdgCacheHome: process.env.XDG_CACHE_HOME,
    homeDir: homedir(),
    repoName: basename(resolve(repoRoot)),
    gitDirReal,
  });
}
