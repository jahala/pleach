/**
 * Integration: the quarantine is a snapshot no hook can refuse (ledger D21,
 * jahala/pleach#96). Real git repos in tmp dirs, real seams wired the way the
 * CLI wires them — no mocks.
 *
 * A planted repository's pre-commit hook refused every commit in a fresh
 * worktree, and pleach kept nothing of a finished build: the quarantine went
 * through `git commit` too. A hook is the repository's gate for what it
 * publishes; it must never decide whether pleach keeps the evidence. So the
 * repositories here refuse everything a commit or a ref update can be refused
 * by — not only pre-commit but reference-transaction, which `update-ref`
 * runs — and every hook leaves its name in a trace outside the tree.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directCliRunner } from '../../src/adapters/direct-cli.ts';
import { gitLedger } from '../../src/adapters/git.ts';
import { PlanSchema } from '../../src/core/plan.ts';
import { type MintFacts, mintReceipt } from '../../src/core/receipt.ts';
import { buildDeps } from '../../src/faces/config.ts';
import type { ConductorDeps } from '../../src/loop/deps.ts';
import { quarantineTree } from '../../src/loop/run-plan.ts';
import { exec } from '../../src/seams/exec.ts';
import { resolveGitDir } from '../../src/seams/gitdir.ts';
import { createIsolateSeam } from '../../src/seams/isolate.ts';
import { createRepo, gitIn } from '../support/git-repo.ts';

const ID = 'kept';

const PLAN = PlanSchema.parse({
  goal: 'the record survives what the repository does',
  source: 'snapshot-quarantine',
  nodes: [{ id: ID, work: { prompt: 'build it' }, policy: { maxAttempts: 1 } }],
});
const NODE = PLAN.nodes[0];

// Every client hook whose exit status can refuse a commit or a ref update.
const REFUSING_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'reference-transaction'];

let repo = '';
let base = '';
let owner = '';
let cleanup: () => Promise<void> = () => Promise.resolve();

beforeEach(async () => {
  const r = await createRepo();
  repo = r.path;
  cleanup = r.cleanup;
  base = await gitIn(repo, 'rev-parse', 'HEAD');
  owner = await mkdtemp(join(tmpdir(), 'pleach-owner-'));
});

afterEach(async () => {
  await cleanup();
  // The owner's worktree dir is this test's own mkdtemp.
  await rm(owner, { recursive: true, force: true });
});

/**
 * Point the repository at hooks that refuse everything, the way a planted
 * `core.hooksPath` does. Linked worktrees share the config, so the node's
 * isolated tree is refused too. Returns the trace every hook appends to.
 */
async function refuseEverything(): Promise<string> {
  const gitDir = resolveGitDir(repo);
  const hooks = join(gitDir, 'refusing-hooks');
  const trace = join(gitDir, 'hook-trace');
  await mkdir(hooks, { recursive: true });
  await writeFile(trace, '');
  for (const name of REFUSING_HOOKS) {
    const path = join(hooks, name);
    await writeFile(
      path,
      `#!/bin/sh\necho ${name} >> '${trace}'\necho "${name}: refused by this repository" >&2\nexit 1\n`,
    );
    await chmod(path, 0o755);
  }
  await gitIn(repo, 'config', 'core.hooksPath', hooks);
  return trace;
}

function failedFacts(): MintFacts {
  return {
    node: ID,
    source: PLAN.source,
    status: 'failed',
    attempts: 1,
    provider: 'claude',
    gates: [{ gate: 'smoke:bun test', exitCode: 1 }],
    acceptance: { smoke: 'bun test' },
    degraded: ['audit:unconfigured'],
    stagedFiles: 1,
    telemetry: {},
    durationMs: 1000,
    pleachVersion: '0.0.1-test',
  };
}

/** The seams the CLI wires for a run: the journal lands in the git dir. */
function cliDeps(): ConductorDeps {
  return buildDeps({ repoRoot: repo, runner: directCliRunner(), ledger: gitLedger({ repo }) });
}

async function journalEvents(): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(resolveGitDir(repo), 'pleach', 'journal.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ledger: D21
test('snapshot records the index and working tree on a branch; no hook runs; HEAD stays', async () => {
  const seam = createIsolateSeam(exec, repo);
  const iso = await seam.isolate(NODE, [base]);
  try {
    const trace = await refuseEverything();
    await writeFile(join(iso.cwd, 'init.txt'), 'rewritten by the worker\n');
    await mkdir(join(iso.cwd, 'src'), { recursive: true });
    await writeFile(join(iso.cwd, 'src', 'partial.ts'), 'export const half = 1;\n');
    // Staging is the caller's, as quarantine stages changedFiles today.
    await seam.stage(iso.cwd, await seam.changedFiles(iso.cwd));

    // The repository refuses the commit: the hook-bound path cannot keep this.
    await expect(seam.commitBranch(iso.cwd, 'node/refused', 'close')).rejects.toThrow(
      'pre-commit: refused by this repository',
    );
    expect(await readFile(trace, 'utf8')).toContain('pre-commit');
    await writeFile(trace, '');

    const message = `pleach: ${ID} quarantined\n\nreceipt-sha256: ${'a'.repeat(64)}`;
    const { sha } = await seam.snapshot(iso.cwd, `quarantine/${ID}`, message);

    // No hook ran — so none could refuse.
    expect(await readFile(trace, 'utf8')).toBe('');
    // The branch names the snapshot, which holds the tree as it stood…
    expect(await gitIn(repo, 'rev-parse', `refs/heads/quarantine/${ID}`)).toBe(sha);
    expect(await gitIn(repo, 'show', `quarantine/${ID}:init.txt`)).toBe('rewritten by the worker');
    expect(await gitIn(repo, 'show', `quarantine/${ID}:src/partial.ts`)).toBe(
      'export const half = 1;',
    );
    // …carries the message, and stands on the tree's own base.
    expect(await gitIn(repo, 'log', '-1', '--format=%B', sha)).toBe(message);
    expect(await gitIn(repo, 'rev-parse', `${sha}^`)).toBe(base);
    // The detached worktree stays where it was.
    expect(await gitIn(iso.cwd, 'rev-parse', 'HEAD')).toBe(base);
  } finally {
    await iso.dispose();
  }
});

// ledger: D21
test('quarantineTree keeps a failed tree in a repository that refuses every commit', async () => {
  const deps = cliDeps();
  const iso = await deps.isolate.isolate(NODE, [base]);
  try {
    await refuseEverything();
    await writeFile(join(iso.cwd, 'partial.txt'), 'half-done\n');
    const receipt = mintReceipt(failedFacts());

    const refs = await quarantineTree(deps, PLAN, NODE, iso, receipt);

    const events = await journalEvents();
    expect(events.filter((e) => e.event === 'quarantine-failed')).toEqual([]);
    expect(refs?.quarantineBranch).toBe(`quarantine/${ID}`);
    const sha = await gitIn(repo, 'rev-parse', `refs/heads/quarantine/${ID}`);
    expect(refs?.quarantineSha).toBe(sha);
    expect(await gitIn(repo, 'show', `quarantine/${ID}:partial.txt`)).toBe('half-done');
    expect(await gitIn(repo, 'log', '-1', '--format=%B', sha)).toContain(
      `receipt-sha256: ${receipt.sha256}`,
    );
    expect(events.find((e) => e.event === 'quarantined')).toMatchObject({
      node: ID,
      branch: `quarantine/${ID}`,
      sha,
    });
  } finally {
    await iso.dispose();
  }
});

// ledger: D21 (keeps #12) — a ref update that runs no hook must still never
// move a branch someone has checked out: their HEAD would jump to a tree their
// index and files do not hold.
test("a quarantine branch checked out in the owner's worktree is never moved; the next name takes it", async () => {
  const ownerTree = join(owner, 'wt');
  await gitIn(repo, 'branch', `quarantine/${ID}`, base);
  await gitIn(repo, 'worktree', 'add', ownerTree, `quarantine/${ID}`);
  const deps = cliDeps();
  const iso = await deps.isolate.isolate(NODE, [base]);
  try {
    await refuseEverything();
    await writeFile(join(iso.cwd, 'partial.txt'), 'half-done again\n');

    const refs = await quarantineTree(deps, PLAN, NODE, iso, mintReceipt(failedFacts()));

    expect(refs?.quarantineBranch).toBe(`quarantine/${ID}.2`);
    expect(await gitIn(repo, 'show', `quarantine/${ID}.2:partial.txt`)).toBe('half-done again');
    // The owner's branch and checkout are exactly as they left them.
    expect(await gitIn(repo, 'rev-parse', `refs/heads/quarantine/${ID}`)).toBe(base);
    expect(await gitIn(ownerTree, 'status', '--porcelain')).toBe('');
  } finally {
    await iso.dispose();
  }
});
