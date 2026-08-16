// gitLedger adapter integration test — uses real git repos in tmp dirs, no mocks.
import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitLedger } from '../../src/adapters/git.ts';
import { LedgerError } from '../../src/core/errors.ts';
import type { Verdict } from '../../src/core/plan.ts';
import { createRepo, gitIn, makeBranch } from '../support/git-repo.ts';

// A node/<id> branch the way run-plan publishes one: the tip commit's message
// carries the plan source (`source: <...>` body line). That line is the
// ledger's scoping key — two plans sharing a repo must not cross-resume.
async function pleachBranch(repo: string, id: string, source: string): Promise<string> {
  const defaultBranch = await gitIn(repo, 'symbolic-ref', '--short', 'HEAD');
  await gitIn(repo, 'checkout', '--detach', 'HEAD');
  await writeFile(join(repo, `${id}.txt`), `${id}\n`);
  await gitIn(repo, 'add', `${id}.txt`);
  await gitIn(
    repo,
    'commit',
    '-m',
    `pleach: ${id} verified (done)\n\nsource: ${source}\ngoal: test goal`,
  );
  const sha = await gitIn(repo, 'rev-parse', 'HEAD');
  await gitIn(repo, 'branch', '-f', `node/${id}`, sha);
  await gitIn(repo, 'checkout', defaultBranch);
  return sha;
}

// ── tests ─────────────────────────────────────────────────────────────────────

// (a) node/* branches published by pleach for THIS source → Map has exactly
// those ids; non-node branches excluded; node/ prefix stripped.
test('gitLedger: readClosed returns Map of node ids → SHAs for the given source', async () => {
  const repo = await createRepo();
  try {
    const shaFoo = await pleachBranch(repo.path, 'foo', 'plan-A');
    const shaBar = await pleachBranch(repo.path, 'bar', 'plan-A');
    await makeBranch(repo.path, 'feature/x'); // must be excluded

    const ledger = gitLedger({ repo: repo.path });
    const closed = await ledger.readClosed('plan-A');

    expect(closed.size).toBe(2);
    expect(closed.get('foo')).toBe(shaFoo);
    expect(closed.get('bar')).toBe(shaBar);
    // node/ prefix must be stripped from keys
    expect(closed.has('node/foo')).toBe(false);
    expect(closed.has('node/bar')).toBe(false);
    // feature branch must not appear
    expect(closed.has('feature/x')).toBe(false);
    expect(closed.has('x')).toBe(false);
  } finally {
    await repo.cleanup();
  }
});

// (a2) Two plans share one repo: each source sees ONLY its own branches. A
// shared node id ('app') must not cross-resume from the other plan's work.
test('gitLedger: readClosed scopes by plan source — no cross-plan collision', async () => {
  const repo = await createRepo();
  try {
    const shaA = await pleachBranch(repo.path, 'app', 'plan-A');
    await pleachBranch(repo.path, 'lib', 'plan-A');
    // plan-B publishes its own 'app' — force-moves the shared node/app ref
    // is not possible (ids collide), so B's branch is what the ref points at
    // AFTER B ran. Simulate: B re-points node/app at a new commit.
    const shaB = await pleachBranch(repo.path, 'app', 'plan-B');

    const ledger = gitLedger({ repo: repo.path });

    const closedB = await ledger.readClosed('plan-B');
    expect(closedB.get('app')).toBe(shaB);
    expect(closedB.has('lib')).toBe(false); // plan-A's work is invisible to B

    const closedA = await ledger.readClosed('plan-A');
    expect(closedA.has('lib')).toBe(true);
    // node/app now belongs to plan-B — A must NOT resume from it.
    expect(closedA.has('app')).toBe(false);
    expect(shaA).not.toBe(shaB);
  } finally {
    await repo.cleanup();
  }
});

// (a3) A hand-made node/* branch with no pleach source line is not verified
// work — it must be excluded for every source (fail closed).
test('gitLedger: readClosed excludes node/* branches without a pleach source line', async () => {
  const repo = await createRepo();
  try {
    await makeBranch(repo.path, 'node/handmade'); // plain commit, no source line

    const ledger = gitLedger({ repo: repo.path });
    const closed = await ledger.readClosed('any-source');

    expect(closed.has('handmade')).toBe(false);
    expect(closed.size).toBe(0);
  } finally {
    await repo.cleanup();
  }
});

// (b) repo with NO node/* branches → empty Map
test('gitLedger: readClosed returns empty Map when no node/* branches exist', async () => {
  const repo = await createRepo();
  try {
    // Only the default branch exists (no node/* branches)
    const ledger = gitLedger({ repo: repo.path });
    const closed = await ledger.readClosed('ignored-source');

    expect(closed.size).toBe(0);
    expect(closed instanceof Map).toBe(true);
  } finally {
    await repo.cleanup();
  }
});

// (c) emitVerdict: done → { closed: true }; failed/dead/aborted → { closed: false }
test('gitLedger: emitVerdict returns { closed: true } for done, { closed: false } for non-done', async () => {
  const repo = await createRepo();
  try {
    const ledger = gitLedger({ repo: repo.path });

    const base: Omit<Verdict, 'status'> = {
      node: 'test-node',
      output: null,
      evidence: { filesTouched: [] },
      telemetry: {},
      attempts: 1,
    };

    const doneVerdict: Verdict = { ...base, status: 'done' };
    const failedVerdict: Verdict = { ...base, status: 'failed' };
    const deadVerdict: Verdict = { ...base, status: 'dead' };
    const abortedVerdict: Verdict = { ...base, status: 'aborted' };

    expect(await ledger.emitVerdict(doneVerdict, 'ignored')).toEqual({ closed: true });
    expect(await ledger.emitVerdict(failedVerdict, 'ignored')).toEqual({ closed: false });
    expect(await ledger.emitVerdict(deadVerdict, 'ignored')).toEqual({ closed: false });
    expect(await ledger.emitVerdict(abortedVerdict, 'ignored')).toEqual({ closed: false });
  } finally {
    await repo.cleanup();
  }
});

// (d) readClosed on a non-git directory → throws LedgerError
test('gitLedger: readClosed on a non-git directory throws LedgerError', async () => {
  const nonGitDir = await mkdtemp(join(tmpdir(), 'pleach-not-git-'));
  try {
    const ledger = gitLedger({ repo: nonGitDir });
    await expect(ledger.readClosed('ignored')).rejects.toThrow(LedgerError);
  } finally {
    await rm(nonGitDir, { recursive: true, force: true });
  }
});
