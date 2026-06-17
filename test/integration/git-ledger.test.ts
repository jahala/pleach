// gitLedger adapter integration test — uses real git repos in tmp dirs, no mocks.
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitLedger } from '../../src/adapters/git.ts';
import { LedgerError } from '../../src/core/errors.ts';
import type { Verdict } from '../../src/core/plan.ts';
import { createRepo, makeBranch } from '../support/git-repo.ts';

// ── tests ─────────────────────────────────────────────────────────────────────

// (a) repo with node/* branches + a non-node branch → Map has exactly the node ids, SHA correct
test('gitLedger: readClosed returns Map of node ids → SHAs, strips node/ prefix, excludes non-node branches', async () => {
  const repo = await createRepo();
  try {
    const shaFoo = await makeBranch(repo.path, 'node/foo');
    const shaBar = await makeBranch(repo.path, 'node/bar');
    await makeBranch(repo.path, 'feature/x'); // must be excluded

    const ledger = gitLedger({ repo: repo.path });
    const closed = await ledger.readClosed('ignored-source');

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
