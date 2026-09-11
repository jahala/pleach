import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

// Resolve a checkout's real git directory. In a normal clone `.git` is a
// directory; in a linked worktree (git-worktree(1)) it is a FILE containing
// `gitdir: <path>`. Every pleach seam that stores state under the git dir
// (lock, journal) must route through this or ENOTDIR from a worktree —
// which conductor-style stacked checkouts hit on first contact.
//
// The answer is always absolute (ledger D22). `--repo-root .` is the documented
// way to run, and a relative git dir reaches the isolate seam as a relative
// worktree path, which `git -C <path>` with `cwd: <path>` resolves twice —
// the second time from inside the worktree, where `.git` is a file.
export function resolveGitDir(repoRoot: string): string {
  const root = resolve(repoRoot);
  const dotGit = join(root, '.git');
  let isDirectory: boolean;
  try {
    isDirectory = statSync(dotGit).isDirectory();
  } catch {
    // No .git at all (bare tmp roots in tests, non-repo runs): preserve the
    // historical path — consumers create it lazily.
    return dotGit;
  }
  if (isDirectory) return dotGit;
  const text = readFileSync(dotGit, 'utf8');
  const match = text.match(/^gitdir:\s*(.+?)\s*$/m);
  if (match === null || match[1] === undefined) {
    throw new Error(`unrecognized .git file at ${dotGit} — expected a "gitdir: <path>" pointer`);
  }
  return isAbsolute(match[1]) ? match[1] : join(root, match[1]);
}
