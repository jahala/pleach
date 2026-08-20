import { deriveStatus, type Receipt, rehash } from '../core/receipt.ts';
import type { ConductorDeps } from './deps.ts';

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

export type ReceiptCheck =
  | { outcome: 'pass'; receipt: Receipt }
  | { outcome: 'tampered'; receipt: Receipt; detail: string }
  | { outcome: 'underivable'; receipt?: Receipt; detail: string };

export async function verifyReceipt(
  nodeId: string,
  deps: Pick<ConductorDeps, 'receipts' | 'isolate'>,
  repoRoot: string,
): Promise<ReceiptCheck> {
  const receipt = await deps.receipts.read(nodeId);
  if (receipt === null) {
    return { outcome: 'underivable', detail: `no receipt on file for '${nodeId}'` };
  }

  if (!rehash(receipt)) {
    return {
      outcome: 'tampered',
      receipt,
      detail: 'the receipt does not hash to its own seal — the file was edited',
    };
  }

  const derivation = deriveStatus(receipt.facts);
  if (!derivation.ok) {
    return { outcome: 'underivable', receipt, detail: derivation.reason };
  }
  if (derivation.status !== receipt.derived) {
    return {
      outcome: 'tampered',
      receipt,
      detail: `the facts imply '${derivation.status}' but the receipt claims '${receipt.derived}'`,
    };
  }

  const ref = receipt.refs?.diffRef ?? receipt.refs?.quarantineSha;
  if (ref === undefined) {
    return {
      outcome: 'underivable',
      receipt,
      detail: 'the receipt carries no refs — nothing to resolve against git',
    };
  }
  const message = await deps.isolate.commitMessageOf(repoRoot, ref);
  if (message === null) {
    return {
      outcome: 'underivable',
      receipt,
      detail: `ref ${ref} does not resolve in this repo (branch deleted or history rewritten)`,
    };
  }
  if (!message.includes(`receipt-sha256: ${receipt.sha256}`)) {
    return {
      outcome: 'tampered',
      receipt,
      detail: `the commit at ${ref} pins a different hash in its trailer — the receipt was re-sealed after settle`,
    };
  }

  return { outcome: 'pass', receipt };
}
