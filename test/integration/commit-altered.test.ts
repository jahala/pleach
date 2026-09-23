/**
 * Integration: the verified commit holds the tree its gates judged (ledger
 * D24). Real git repos in tmp dirs, the real isolate seam — no mocks.
 *
 * The verified commit runs the repository's hooks (D21), and a pre-commit hook
 * can change the index while `git commit` runs. Every worktree shares the
 * repository's hooks directory, so a hook written from inside one node's tree
 * runs in every other node's commit. Either way the commit would publish bytes
 * no gate saw. commitBranch compares the committed tree with the staged one and
 * refuses before it moves the branch.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CommitAlteredError } from '../../src/core/errors.ts';
import { PlanSchema } from '../../src/core/plan.ts';
import { exec } from '../../src/seams/exec.ts';
import { resolveGitDir } from '../../src/seams/gitdir.ts';
import { createIsolateSeam } from '../../src/seams/isolate.ts';
import { createRepo, execLocal, gitIn } from '../support/git-repo.ts';

const NODE = PlanSchema.parse({
  goal: 'the verified commit holds the judged tree',
  source: 'commit-altered',
  nodes: [{ id: 'built', work: { command: 'true' } }],
}).nodes[0];

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

// The hook lands in the shared hooks directory, where a worker reaches it
// through its worktree's `.git` pointer.
async function plantPreCommit(body: string): Promise<void> {
  const path = join(resolveGitDir(repo), 'hooks', 'pre-commit');
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

async function branchExists(branch: string): Promise<boolean> {
  const r = await execLocal(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', branch], repo);
  return r.exitCode === 0;
}

// ledger: D24 — a hook that stages a file the gates never saw.
test('a pre-commit hook that stages an extra file: commitBranch refuses, the branch never moves', async () => {
  const seam = createIsolateSeam(exec, repo);
  const iso = await seam.isolate(NODE, ['HEAD']);
  try {
    await writeFile(join(iso.cwd, 'built.txt'), 'judged\n');
    await seam.stage(iso.cwd, ['built.txt']);
    await plantPreCommit('echo smuggled > smuggled.txt\ngit add smuggled.txt');

    const err = await seam.commitBranch(iso.cwd, 'node/built', 'verified').catch((e) => e);

    expect(err).toBeInstanceOf(CommitAlteredError);
    expect((err as CommitAlteredError).changed).toContain('smuggled.txt');
    expect((err as CommitAlteredError).changed).not.toContain('built.txt');
    expect(await branchExists('node/built')).toBe(false);
  } finally {
    await iso.dispose();
  }
}, 30_000);

// ledger: D24 — a hook that rewrites a staged file (a formatter, say).
test('a pre-commit hook that rewrites a judged file: refused, naming the file', async () => {
  const seam = createIsolateSeam(exec, repo);
  const iso = await seam.isolate(NODE, ['HEAD']);
  try {
    await writeFile(join(iso.cwd, 'built.txt'), 'judged\n');
    await seam.stage(iso.cwd, ['built.txt']);
    await plantPreCommit('echo rewritten > built.txt\ngit add built.txt');

    const err = await seam.commitBranch(iso.cwd, 'node/built', 'verified').catch((e) => e);

    expect(err).toBeInstanceOf(CommitAlteredError);
    expect((err as CommitAlteredError).changed).toContain('built.txt');
    expect(await branchExists('node/built')).toBe(false);
  } finally {
    await iso.dispose();
  }
}, 30_000);

// ledger: D24 — D21 stands: a hook that only checks still runs and passes.
test('a pre-commit hook that checks and changes nothing: the commit publishes as before', async () => {
  const seam = createIsolateSeam(exec, repo);
  const iso = await seam.isolate(NODE, ['HEAD']);
  try {
    const trace = join(resolveGitDir(repo), 'hook-ran');
    await writeFile(join(iso.cwd, 'built.txt'), 'judged\n');
    await seam.stage(iso.cwd, ['built.txt']);
    await plantPreCommit(`echo ran > '${trace}'`);

    const { sha } = await seam.commitBranch(iso.cwd, 'node/built', 'verified');

    expect(await gitIn(repo, 'rev-parse', 'node/built')).toBe(sha);
    expect(await gitIn(repo, 'show', 'node/built:built.txt')).toBe('judged');
    expect(await Bun.file(trace).text()).toBe('ran\n');
  } finally {
    await iso.dispose();
  }
}, 30_000);

// ledger: D24 — the red-phase seal (D13) runs the same hooks and holds the same line.
test('a pre-commit hook that stages a file into the red-phase seal: refused, HEAD stays put', async () => {
  const seam = createIsolateSeam(exec, repo);
  const iso = await seam.isolate(NODE, ['HEAD']);
  try {
    const before = await gitIn(iso.cwd, 'rev-parse', 'HEAD');
    await writeFile(join(iso.cwd, 'red.test.txt'), 'the failing test\n');
    await seam.stage(iso.cwd, ['red.test.txt']);
    await plantPreCommit('echo smuggled > smuggled.txt\ngit add smuggled.txt');

    const err = await seam.commit(iso.cwd, 'red phase').catch((e) => e);

    expect(err).toBeInstanceOf(CommitAlteredError);
    expect((err as CommitAlteredError).changed).toContain('smuggled.txt');
    expect(await gitIn(iso.cwd, 'rev-parse', 'HEAD')).toBe(before);
  } finally {
    await iso.dispose();
  }
}, 30_000);
