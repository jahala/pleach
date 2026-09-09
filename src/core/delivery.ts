import { isAbsolute, relative, resolve, sep } from 'node:path';

// What a node delivers, decided from the path alone (ledger D14).
//
// The worker's touched set is a manifest, not a promise: umbel's editor hands
// back absolute paths, the work order sends probes to `.loop-scratch/`, and
// weeder/tend2 write a friction journal inside the tree. `git add` of an
// ignored path exits 1 and of a path outside the worktree exits 128 — either
// one killed a FINISHED node and disposed its tree (jahala/pleach#74, #79).
// So collection decides what is not delivery BEFORE it stages anything; this
// is the half that needs no git.
//
// Set aside here: the two directories that are never delivery, and anything
// that does not resolve inside the worktree. What git ignores is the seam's
// question (`IsolateSeam.ignored`) — it needs the repo's rules and its index.

// Directory prefixes (worktree-relative) that are never part of a delivery:
// the work order's scratch dir, and the friction ledger's month files.
const NEVER_DELIVERY = ['.loop-scratch', '.plotplot/friction'];

export interface DeliveryPartition {
  /** Delivery paths, normalised relative to the worktree, in input order. */
  keep: string[];
  /** Everything else, verbatim as the caller named it — what the journal records. */
  setAside: string[];
}

/**
 * Split a worker's touched set into what may be staged and what may not.
 * Total and I/O-free: every input lands in exactly one bucket, and no input —
 * absolute, traversing, empty or malformed — can make it throw.
 */
export function partitionDelivery(paths: readonly string[], cwd: string): DeliveryPartition {
  // Anchored at '/' so resolution never consults the process's own cwd: the
  // answer depends on the arguments alone.
  const root = resolve('/', cwd);
  const keep: string[] = [];
  const setAside: string[] = [];
  for (const path of paths) {
    const rel = within(root, path);
    if (rel === null || isNeverDelivery(rel)) setAside.push(path);
    else keep.push(rel);
  }
  return { keep, setAside };
}

// The path relative to the worktree root, or null when it is not inside it.
// An absolute path inside the tree normalises to its relative form — that is
// how umbel's manifest names files, and staging them absolute works only by
// accident. '' is the root itself: a pathspec meaning "everything", never a
// file a worker delivered.
function within(root: string, path: string): string | null {
  const abs = isAbsolute(path) ? resolve('/', path) : resolve(root, path);
  const rel = relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return rel;
}

// Prefix match on whole segments: `.loop-scratchy/keep.ts` is delivery.
function isNeverDelivery(rel: string): boolean {
  return NEVER_DELIVERY.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
}
