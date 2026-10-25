import type { IsolateSeam } from './deps.ts';

// The refs a verified close records beside diffRef (issue #105): the commit's
// stable patch-id and its committer timestamp (the close time). Both are read
// through the isolate seam, bound by git, and live outside the hashed envelope,
// so every receipt already on disk still hashes and verifies. A commit that
// yields neither (unreadable, no diff) returns undefined and the receipt
// carries only its diffRef, exactly as before.
export async function patchRefs(
  isolate: IsolateSeam,
  cwd: string,
  sha: string,
): Promise<{ patchId: string; closedAt: number } | undefined> {
  const [patchId, closedAt] = await Promise.all([
    isolate.commitPatchId(cwd, sha),
    isolate.commitTime(cwd, sha),
  ]);
  if (patchId === null || closedAt === null) return undefined;
  return { patchId, closedAt };
}
