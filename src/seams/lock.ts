import { createHash } from 'node:crypto';
import { open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LockHeldError, type LockKind, NoRunError } from '../core/errors.ts';
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

// ledger: D18 — the landing's lock, beside the run's and named from it, so the
// pair is found together and cannot drift apart. Two locks because they guard
// different things: the run's state is the run's, the base branch is the
// landing's, and neither writes the other's — a landing that queued behind the
// run's lock would wait on gates it has no stake in.
function landLockPath(repoRoot: string, source: string): string {
  return `${lockPath(repoRoot, source)}.land`;
}

// ledger: D16 — the drain marker, beside the lock of the run it drains, so the
// two are named by the same (repoRoot, source) and cannot drift apart. Nothing
// reads the file's bytes: its presence IS the request, which is what makes the
// scheduler's per-launch read a single cheap stat.
export function stopPath(repoRoot: string, source: string): string {
  return `${lockPath(repoRoot, source)}.stop`;
}

// The pid of the run that holds this (repoRoot, source), or NoRunError. A dead
// pid is not a run: a stale lockfile outlives the process that wrote it (B4),
// and draining it would leave a marker for a run that will never read it.
async function liveHolder(repoRoot: string, source: string): Promise<number> {
  const pid = await readPid(lockPath(repoRoot, source));
  if (pid === null || !isAlive(pid)) throw new NoRunError(source);
  return pid;
}

// ledger: D16 — write the drain marker for a live run and answer whose it is.
// The bytes are nothing; the file's presence is the whole request, which is what
// lets the scheduler ask for it with a single stat per launch decision.
export async function requestStop(repoRoot: string, source: string): Promise<number> {
  const pid = await liveHolder(repoRoot, source);
  await writeFile(stopPath(repoRoot, source), '', 'utf8');
  return pid;
}

// ledger: D16 — the hard abort (`stop --now`), sent to the pid the lock names.
// Signalling lives here and not in the face for the same reason the marker does:
// the (repoRoot, source) → holder mapping is the lock's, and nothing above the
// seams touches a process.
export async function signalRun(
  repoRoot: string,
  source: string,
  signal: NodeJS.Signals,
): Promise<number> {
  const pid = await liveHolder(repoRoot, source);
  process.kill(pid, signal);
  return pid;
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

// The acquire ladder, walked the same way for both locks: O_EXCL, then the
// holder's liveness, then one stale takeover. `lock` only names the refusal —
// the rules do not differ, and a second ladder would be a second set of races.
async function acquireAt(path: string, lock: LockKind): Promise<LockHandle> {
  // First attempt — fast path
  if (await tryAcquireExcl(path)) {
    return makeHandle(path);
  }

  // File exists — inspect the holder
  const pid = await readPid(path);

  if (pid !== null && isAlive(pid)) {
    throw new LockHeldError(path, pid, lock);
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
  throw new LockHeldError(path, newPid ?? 0, lock);
}

export function createLockSeam(): LockSeam {
  return {
    async acquire(repoRoot: string, source: string): Promise<LockHandle> {
      return await acquireAt(lockPath(repoRoot, source), 'run');
    },

    async acquireLand(repoRoot: string, source: string): Promise<LockHandle> {
      return await acquireAt(landLockPath(repoRoot, source), 'land');
    },

    async stopRequested(repoRoot: string, source: string): Promise<boolean> {
      try {
        await stat(stopPath(repoRoot, source));
        return true;
      } catch (err) {
        // Absent is the answer "no drain". Anything else — an unreadable git
        // dir, a permission refusal — is not an answer, and a run must not
        // read it as one: it would keep launching through an operator's stop.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
    },

    async clearStop(repoRoot: string, source: string): Promise<void> {
      try {
        await unlink(stopPath(repoRoot, source));
      } catch (err) {
        // Idempotent, like the lock's own release: nothing to consume means
        // the drain is already consumed.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
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
