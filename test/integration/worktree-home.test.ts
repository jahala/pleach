// issue #174: node worktrees and land stacks live outside `.git/`. Biome turns
// its React rules off for any path under `.git/`, so a gate run in a worktree
// under `<git-dir>/pleach/worktrees/` checks fewer rules than the same gate on
// the branch — and nothing showed it. The home is `$PLEACH_WORKTREE_HOME` (set
// by the test preload to a fresh temp folder), else the XDG cache, else
// `~/.cache`; under it, one directory per repository. Real git, no mocks.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { gitLedger } from '../../src/adapters/git.ts';
import { PlanSchema } from '../../src/core/plan.ts';
import { buildDeps } from '../../src/faces/config.ts';
import type { RunnerSeam } from '../../src/loop/deps.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { exec } from '../../src/seams/exec.ts';
import { resolveGitDir } from '../../src/seams/gitdir.ts';
import { createIsolateSeam } from '../../src/seams/isolate.ts';
import { createRepo } from '../support/git-repo.ts';

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

const HOME = process.env.PLEACH_WORKTREE_HOME;

// A real RunnerSeam: the worker writes its delivery into the worktree it was
// given and hands it back, exactly as a prompt node's worker would.
function writingRunner(): RunnerSeam {
  return {
    async spawnWorker(spec) {
      return {
        async send() {},
        async wait() {
          await writeFile(join(spec.cwd, 'work.txt'), 'built\n');
          return {
            finalMessage: 'built it',
            filesTouched: ['work.txt'],
            reason: 'stop' as const,
            telemetry: {},
          };
        },
        async kill() {},
      };
    },
  };
}

// A smoke that fails exactly when the worktree sits under a `.git/` directory:
// the issue's point, a gate that behaves differently under `.git/`.
const NOT_UNDER_GIT = 'bash -lc \'case "$PWD" in */.git/*) echo "inside .git"; exit 1;; esac\'';

test('a node whose smoke refuses a .git/ path closes verified — the worktree is outside .git/', async () => {
  const plan = PlanSchema.parse({
    goal: 'worktree is not under .git',
    source: 'worktree-home-smoke',
    nodes: [
      {
        id: 'n',
        work: { prompt: 'build n' },
        accept: { smoke: NOT_UNDER_GIT },
        policy: { maxAttempts: 1 },
      },
    ],
  });

  const deps = buildDeps({
    repoRoot: repo,
    redaction: 'off',
    runner: writingRunner(),
    ledger: gitLedger({ repo }),
  });

  const summary = await runPlan(plan, deps, { repoRoot: repo, defaultTimeoutMs: 60_000 });
  expect(summary.closed).toEqual(['n']);
}, 60_000);

test('a node worktree lives under $PLEACH_WORKTREE_HOME/<repo-dir>/, not the git dir', async () => {
  expect(HOME).toBeDefined();
  const seam = createIsolateSeam(exec, repo);
  const iso = await seam.isolate({ id: 'x' } as Parameters<typeof seam.isolate>[0], ['HEAD']);
  try {
    expect(iso.cwd.startsWith(`${HOME}/`)).toBe(true);
    expect(iso.cwd.includes('/.git/')).toBe(false);
    expect(iso.cwd.startsWith(resolveGitDir(repo))).toBe(false);
    // One directory per repository: <basename of the repo root>-<12 hex>.
    const repoDir = iso.cwd.slice((HOME as string).length + 1).split('/')[0] as string;
    expect(repoDir).toMatch(new RegExp(`^${basename(repo)}-[0-9a-f]{12}$`));
  } finally {
    await iso.dispose();
  }
});

test('a land stack lives under $PLEACH_WORKTREE_HOME/<repo-dir>/, not the git dir', async () => {
  expect(HOME).toBeDefined();
  const seam = createIsolateSeam(exec, repo);
  const stack = await seam.landStack(repo, []);
  try {
    expect(stack.cwd.startsWith(`${HOME}/`)).toBe(true);
    expect(stack.cwd.includes('/.git/')).toBe(false);
    expect(stack.cwd.startsWith(resolveGitDir(repo))).toBe(false);
    const repoDir = stack.cwd.slice((HOME as string).length + 1).split('/')[0] as string;
    expect(repoDir).toMatch(new RegExp(`^${basename(repo)}-[0-9a-f]{12}$`));
  } finally {
    await stack.dispose();
  }
});
