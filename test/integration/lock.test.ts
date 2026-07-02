import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LockHeldError } from '../../src/core/errors.ts';
import { createLockSeam } from '../../src/seams/lock.ts';

async function makeTmpRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pleach-lock-test-'));
  // Simulate .git directory so the lock path is deterministic
  await rm(join(dir, '.git'), { recursive: true, force: true });
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

describe('lock seam', () => {
  // Regression: pleach run from a linked git worktree (git-worktree(1)), where
  // `.git` is a FILE containing `gitdir: <path>` — the lock must land inside
  // the pointed-at git dir instead of ENOTDIRing under the pointer file.
  test('acquires from a linked worktree whose .git is a gitdir: pointer file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pleach-lock-wt-'));
    const realGitDir = join(dir, 'main', '.git', 'worktrees', 'wt');
    const { mkdirSync, readdirSync } = await import('node:fs');
    mkdirSync(realGitDir, { recursive: true });
    const worktree = join(dir, 'wt');
    mkdirSync(worktree, { recursive: true });
    await writeFile(join(worktree, '.git'), `gitdir: ${realGitDir}\n`, 'utf8');

    const lock = createLockSeam();
    const handle = await lock.acquire(worktree, 'wt-source');
    try {
      const locks = readdirSync(realGitDir).filter((f) => f.startsWith('pleach-'));
      expect(locks.length).toBe(1);
    } finally {
      await handle.release();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ledger: B4 — second acquire from same process throws LockHeldError with holder pid
  test('B4: second acquire throws LockHeldError with the holder pid', async () => {
    const repoRoot = await makeTmpRepo();
    const lock = createLockSeam();
    const handle = await lock.acquire(repoRoot, 'test-source');
    try {
      await expect(lock.acquire(repoRoot, 'test-source')).rejects.toBeInstanceOf(LockHeldError);
      // Also check that the error has the correct pid
      try {
        await lock.acquire(repoRoot, 'test-source');
      } catch (err) {
        expect(err).toBeInstanceOf(LockHeldError);
        expect((err as LockHeldError).pid).toBe(process.pid);
      }
    } finally {
      await handle.release();
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  // ledger: B4 — release then reacquire works
  test('B4: release → reacquire works', async () => {
    const repoRoot = await makeTmpRepo();
    const lock = createLockSeam();
    const handle1 = await lock.acquire(repoRoot, 'test-source');
    await handle1.release();
    const handle2 = await lock.acquire(repoRoot, 'test-source');
    await handle2.release();
    await rm(repoRoot, { recursive: true, force: true });
  });

  // ledger: B4 — stale lock (dead pid) is taken over
  test('B4: stale lock with dead pid is taken over', async () => {
    const repoRoot = await makeTmpRepo();
    // 999999 is virtually guaranteed to be dead
    const deadPid = 999999;
    // Verify it's actually dead before relying on this
    let isActuallyDead = false;
    try {
      process.kill(deadPid, 0);
    } catch {
      isActuallyDead = true;
    }
    expect(isActuallyDead).toBe(true);

    // Manually plant the stale lockfile
    const crypto = await import('node:crypto');
    const sha = crypto.createHash('sha1').update('test-source').digest('hex').slice(0, 12);
    const lockPath = join(repoRoot, '.git', `pleach-${sha}.lock`);
    await writeFile(lockPath, String(deadPid), { encoding: 'utf8' });

    const lock = createLockSeam();
    const handle = await lock.acquire(repoRoot, 'test-source');
    // Acquisition succeeded — verify the lockfile now holds our pid
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(lockPath, 'utf8');
    expect(Number(content.trim())).toBe(process.pid);
    await handle.release();
    await rm(repoRoot, { recursive: true, force: true });
  });

  // ledger: B4 — lockfile content is the acquiring pid
  test('B4: lockfile content is the acquiring pid', async () => {
    const repoRoot = await makeTmpRepo();
    const lock = createLockSeam();
    const handle = await lock.acquire(repoRoot, 'test-source');

    const crypto = await import('node:crypto');
    const sha = crypto.createHash('sha1').update('test-source').digest('hex').slice(0, 12);
    const lockPath = join(repoRoot, '.git', `pleach-${sha}.lock`);
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(lockPath, 'utf8');
    expect(Number(content.trim())).toBe(process.pid);

    await handle.release();
    await rm(repoRoot, { recursive: true, force: true });
  });
});
