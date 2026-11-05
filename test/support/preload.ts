import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Loaded before every test file (bunfig.toml). Child `pleach` processes the
// e2e tests spawn inherit this environment.
process.env.PLEACH_SETTLE_MS ??= '0';

// Issue #174: worktrees must live outside `.git/` (Biome turns its React rules
// off there). Tests never write into a real cache: this process's worktree home
// is a fresh temp folder, removed when the process exits. The CLI the e2e tests
// spawn inherits it, so every worktree a test makes is swept with its folder.
if (process.env.PLEACH_WORKTREE_HOME === undefined) {
  const home = mkdtempSync(join(tmpdir(), 'pleach-test-worktree-home-'));
  process.env.PLEACH_WORKTREE_HOME = home;
  process.on('exit', () => {
    rmSync(home, { recursive: true, force: true });
  });
}
