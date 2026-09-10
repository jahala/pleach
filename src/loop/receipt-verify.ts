import type { Verdict } from '../core/plan.ts';
import { type DerivedStatus, deriveStatus, type Receipt, rehash } from '../core/receipt.ts';
import type { ConductorDeps, ReceiptStore } from './deps.ts';

// The receipt verb's engine (§D): three checks against a settled node's
// receipt, each with one honest failure mode.
//
//   1. Seal    — the envelope still hashes to its sha256 (else TAMPERED).
//   2. Derive  — the facts still imply the recorded status, behind the
//                contract-version fence (fence → UNDERIVABLE, mismatch →
//                TAMPERED: someone edited derived or facts and re-sealed).
//   3. Trailer — the commit the receipt's ref names pins this exact hash in
//                immutable history (missing ref → UNDERIVABLE, different
//                hash → TAMPERED: a re-sealed forgery caught by git).
//
// TAMPERED means the record contradicts itself or history; UNDERIVABLE means
// nothing is proved either way (no receipt, foreign version, lost ref).
//
// Beside the verdict rides the node's history (D17): every earlier close, in
// the order `refs.previousReceiptSha256` links them. A listing, not a second
// verification — the three checks above are the latest close's, and a prior
// close is read for what it recorded. A link whose file is gone is reported as
// the gap it is; the walk cannot go past it, because that file held the link.

export type ReceiptHistoryEntry =
  | { sha256: string; status: Verdict['status']; derived: DerivedStatus }
  | { sha256: string; missing: true };

export type ReceiptCheck =
  | { outcome: 'pass'; receipt: Receipt; history: ReceiptHistoryEntry[] }
  | { outcome: 'tampered'; receipt: Receipt; detail: string; history: ReceiptHistoryEntry[] }
  | {
      outcome: 'underivable';
      receipt?: Receipt;
      detail: string;
      history: ReceiptHistoryEntry[];
    };

async function walkHistory(
  nodeId: string,
  latest: Receipt,
  receipts: ReceiptStore,
): Promise<ReceiptHistoryEntry[]> {
  const history: ReceiptHistoryEntry[] = [];
  // A hand-edited chain can point back at a close already walked; stop there
  // rather than follow it forever.
  const walked = new Set<string>([latest.sha256]);
  let sha = latest.refs?.previousReceiptSha256;
  while (sha !== undefined && !walked.has(sha)) {
    walked.add(sha);
    const prior = await receipts.readAt(nodeId, sha);
    if (prior === null) {
      history.push({ sha256: sha, missing: true });
      return history;
    }
    history.push({ sha256: sha, status: prior.facts.status, derived: prior.derived });
    sha = prior.refs?.previousReceiptSha256;
  }
  return history;
}

export async function verifyReceipt(
  nodeId: string,
  deps: Pick<ConductorDeps, 'receipts' | 'isolate'>,
  repoRoot: string,
): Promise<ReceiptCheck> {
  const receipt = await deps.receipts.read(nodeId);
  if (receipt === null) {
    return { outcome: 'underivable', history: [], detail: `no receipt on file for '${nodeId}'` };
  }
  const history = await walkHistory(nodeId, receipt, deps.receipts);

  if (!rehash(receipt)) {
    return {
      outcome: 'tampered',
      receipt,
      history,
      detail: 'the receipt does not hash to its own seal — the file was edited',
    };
  }

  const derivation = deriveStatus(receipt.facts);
  if (!derivation.ok) {
    return { outcome: 'underivable', receipt, history, detail: derivation.reason };
  }
  if (derivation.status !== receipt.derived) {
    return {
      outcome: 'tampered',
      receipt,
      history,
      detail: `the facts imply '${derivation.status}' but the receipt claims '${receipt.derived}'`,
    };
  }

  const ref = receipt.refs?.diffRef ?? receipt.refs?.quarantineSha;
  if (ref === undefined) {
    return {
      outcome: 'underivable',
      receipt,
      history,
      detail: 'the receipt carries no refs — nothing to resolve against git',
    };
  }
  const message = await deps.isolate.commitMessageOf(repoRoot, ref);
  if (message === null) {
    return {
      outcome: 'underivable',
      receipt,
      history,
      detail: `ref ${ref} does not resolve in this repo (branch deleted or history rewritten)`,
    };
  }
  if (!message.includes(`receipt-sha256: ${receipt.sha256}`)) {
    return {
      outcome: 'tampered',
      receipt,
      history,
      detail: `the commit at ${ref} pins a different hash in its trailer — the receipt was re-sealed after settle`,
    };
  }

  return { outcome: 'pass', receipt, history };
}
