import { expect, test } from 'bun:test';
import { worktreeHome } from '../../src/core/worktree-home.ts';

// issue #174: the pure home function — where node worktrees and land stacks
// live. Given env values, the home dir and the repo's identifying facts as
// data, it returns one directory per repository under a shared base. No fs, no
// processes: the seam reads env/homedir/realpath and calls this.

const HEX12 = '[0-9a-f]{12}';

test('$PLEACH_WORKTREE_HOME is the base when set — nothing is appended', () => {
  const home = worktreeHome({
    worktreeHome: '/explicit/home',
    xdgCacheHome: '/xdg',
    homeDir: '/home/jan',
    repoName: 'bandung',
    gitDirReal: '/repos/bandung/.git',
  });
  expect(home).toMatch(new RegExp(`^/explicit/home/bandung-${HEX12}$`));
});

test('$XDG_CACHE_HOME/pleach/worktrees is the base when no override is set', () => {
  const home = worktreeHome({
    xdgCacheHome: '/xdg',
    homeDir: '/home/jan',
    repoName: 'bandung',
    gitDirReal: '/repos/bandung/.git',
  });
  expect(home).toMatch(new RegExp(`^/xdg/pleach/worktrees/bandung-${HEX12}$`));
});

test('~/.cache/pleach/worktrees is the base when neither variable is set', () => {
  const home = worktreeHome({
    homeDir: '/home/jan',
    repoName: 'bandung',
    gitDirReal: '/repos/bandung/.git',
  });
  expect(home).toMatch(new RegExp(`^/home/jan/.cache/pleach/worktrees/bandung-${HEX12}$`));
});

test('two repos with the same basename get different directories', () => {
  const a = worktreeHome({
    homeDir: '/home/jan',
    repoName: 'bandung',
    gitDirReal: '/repos/a/.git',
  });
  const b = worktreeHome({
    homeDir: '/home/jan',
    repoName: 'bandung',
    gitDirReal: '/repos/b/.git',
  });
  expect(a).not.toBe(b);
});
