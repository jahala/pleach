#!/usr/bin/env bun
// Test fixture: hold a real pleach lock in a real process, so `pleach stop` has
// a live holder to find and a live pid to signal, and a landing has a live
// holder to be refused by. Which lock is the third argument: 'run' (the
// conductor's, the default) or 'land' (the landing's, beside it — D18). Prints
// 'held' once the lock is on disk, then waits. SIGINT → exit 42, a code nothing
// else here produces, so a test can tell "the face signalled this process" from
// "the process died".
import { createLockSeam } from '../../src/seams/lock.ts';

const [repoRoot, source, which = 'run'] = process.argv.slice(2);
if (repoRoot === undefined || source === undefined || (which !== 'run' && which !== 'land')) {
  process.stderr.write('usage: hold-lock.ts <repo-root> <source> [run|land]\n');
  process.exit(2);
}

const lock = createLockSeam();
await (which === 'land' ? lock.acquireLand(repoRoot, source) : lock.acquire(repoRoot, source));
process.on('SIGINT', () => process.exit(42));
process.stdout.write('held\n');
// Ride until signalled or killed; the test owns this process's end.
setInterval(() => {}, 1000);
