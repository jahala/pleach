// What exists only on this machine (issue #130).
//
// pleach never pushes — the conductor does — so "verified" and "landed" have
// always meant local. Until now nothing said whether a verified node branch or
// a landed branch exists on any remote, so work could sit stranded on the one
// laptop with nobody knowing. This module computes the honest answer from the
// local refs and the remote-tracking refs, passed in as DATA: the I/O that
// gathers them lives in the isolate seam, which reads git over local data only
// (no network). Pure and total — the report is a function of the refs, nothing
// else.

export interface LocalOnlyNodeBranch {
  // The branch's short name, e.g. "node/api".
  name: string;
  // Its tip commit SHA.
  sha: string;
}

export interface LocalOnlyFacts {
  // Every node/* branch in the repository. pleach publishes node/* only for
  // verified work, so these are the verified branches.
  nodeBranches: readonly LocalOnlyNodeBranch[];
  // The set of commit SHAs reachable from any remote-tracking ref. A node
  // branch whose tip is in this set is on some remote.
  reachableFromRemote: ReadonlySet<string>;
  // How many remotes the repository has configured.
  remotes: number;
}

export interface LocalOnlyReport {
  // The node/* branch names (sorted) whose tip is on no remote.
  nodeBranches: string[];
  remotes: number;
}

// Which verified node branches exist on no remote, and how many remotes there
// are. `remotes` is carried through so a caller can tell "on a remote" from
// "no remote at all".
export function computeLocalOnly(facts: LocalOnlyFacts): LocalOnlyReport {
  const nodeBranches = facts.nodeBranches
    .filter((b) => !facts.reachableFromRemote.has(b.sha))
    .map((b) => b.name)
    .sort();
  return { nodeBranches, remotes: facts.remotes };
}

// A landed branch's relationship to its upstream, as the seam read it from git.
export interface BranchUpstream {
  // The upstream's short name (e.g. "origin/main"), or null when the branch has
  // no upstream configured.
  upstream: string | null;
  // How many commits the branch is ahead of its upstream. Meaningless when
  // `upstream` is null.
  ahead: number;
}

// How many commits a landed branch is ahead of its upstream, or null when it
// has no upstream. Null is the honest "there is nothing to be ahead of", never
// a number invented for a branch that tracks nothing.
export function aheadOfUpstream(facts: BranchUpstream): number | null {
  return facts.upstream === null ? null : facts.ahead;
}
