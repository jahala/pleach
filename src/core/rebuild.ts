// The rebuild pin a land conflict leaves (issue #116). When a landing refuses
// on a sink whose branch conflicts with a sibling that landed before it, the
// stack commit it conflicted against is kept alive under this ref so the next
// `pleach run` can rebuild the node on it — instead of the operator merging by
// hand outside the record. One home for the ref name: loop/land.ts writes it,
// loop/run-plan.ts reads and clears it.

export const REBUILD_REFS = 'refs/pleach/rebuild/';

export function rebuildRef(id: string): string {
  return `${REBUILD_REFS}${id}`;
}
