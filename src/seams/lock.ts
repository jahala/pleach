import { createHash } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { LockHeldError } from '../core/errors.ts';
import type { LockHandle, LockSeam } from '../loop/deps.ts';
import { resolveGitDir } from './gitdir.ts';

// ledger: B4 — O_EXCL pid lockfile per (repoRoot, source); stale-lock takeover.
//
// Lockfile path: <git-dir>/pleach-<sha1(source) first 12 hex>.lock, where
// <git-dir> is <repoRoot>/.git when that is a directory, or the directory a
// linked worktree's `.git` FILE points at (`gitdir: <path>`). Locking stays
// per-checkout either way: same repoRoot → same git dir → same lock.
// Content: the acquiring process's pid as a decimal string.
//
// Acquire protocol:
//   1. Try to open with O_EXCL (atomic, no TOCTOU).
//   2. EEXIST → read the existing pid.
//      a. process.kill(pid, 0) succeeds (or EPERM) → live holder → throw LockHeldError.
//      b. ESRCH → stale → unlink + retry wx once.
//   3. Write our pid and return a handle whose release() unlinks the file.

function lockPath(repoRoot: string, source: string): string {
  const sha = createHash('sha1').update(source).digest('hex').slice(0, 12);
  return join(resolveGitDir(repoRoot), `pleach-${sha}.lock`);
}

// Returns true on success, false on EEXIST; re-throws other errors.
async function tryAcquireExcl(path: string): Promise<boolean> {
  try {
    // 'wx' = O_WRONLY | O_CREAT | O_EXCL — fails atomically if file exists
    const fh = await open(path, 'wx');
    await fh.writeFile(String(process.pid), 'utf8');
    await fh.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export async function readPid(path: string): Promise<number | null> {
  try {
    const text = await readFile(path, 'utf8');
    const pid = Number(text.trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // No throw → process exists (we may not have permission, but it's live)
    return true;
  } catch (err) {
    // ESRCH → no such process → stale
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    // EPERM → process exists but we can't signal it → live
    return true;
  }
}

export function createLockSeam(): LockSeam {
  return {
    async acquire(repoRoot: string, source: string): Promise<LockHandle> {
      const path = lockPath(repoRoot, source);

      // First attempt — fast path
      if (await tryAcquireExcl(path)) {
        return makeHandle(path);
      }

      // File exists — inspect the holder
      const pid = await readPid(path);

      if (pid !== null && isAlive(pid)) {
        throw new LockHeldError(path, pid);
      }

      // Stale lock: unlink and retry once
      try {
        await unlink(path);
      } catch (err) {
        // Another process may have raced us to the unlink — that's fine
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }

      // Retry wx after clearing the stale file
      if (await tryAcquireExcl(path)) {
        return makeHandle(path);
      }

      // Lost the race after stale takeover: read the new holder
      const newPid = await readPid(path);
      throw new LockHeldError(path, newPid ?? 0);
    },
  };
}

function makeHandle(path: string): LockHandle {
  return {
    async release(): Promise<void> {
      try {
        await unlink(path);
      } catch (err) {
        // Idempotent: ENOENT means already released, which is fine
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    },
  };
}
