// Close receipts (§D) — the honesty ledger's pure heart. A receipt freezes
// the facts the conductor actually held at classify time, derives what those
// facts imply, and seals both under a sha256 the node commit's trailer pins
// into immutable git history.
//
// The freeze point is load-bearing (the loki lesson: their verifier accused
// honest receipts of forgery over post-derivation appends). Facts freeze
// BEFORE the commit exists, so the commit SHA cannot live inside the hashed
// envelope — git binds them instead: the trailer rides in the commit whose
// SHA is the diffRef. Likewise the ledger's dual-close decision lands after
// the commit, so `derived` is the CONDUCTOR's own implication — 'publishable'
// (done, gates green, no audit fail) — never a claim about what tend decided.
// Refs and the settled outcome ride on the receipt file OUTSIDE the envelope.
//
// Hashing is stdlib computation (no I/O, deterministic) — core stays pure.
import { createHash } from 'node:crypto';
import type { Verdict } from './plan.ts';

// Pinned to the canonical doc's header (docs/contract/plan-schema.md); the
// unit test asserts the pin. The fence makes an old receipt fail derivation
// honestly ("wrong contract version"), never mysteriously.
export const CONTRACT_VERSION = '1.1.5';

export interface GateRecord {
  gate: string; // ladder step: 'setup' | 'marker' | 'hygiene[:<kind>]' | 'smoke' | 'audit-tamper'
  exitCode: number;
  // sha256 of the failing gate's journaled output tail — the journal keeps
  // the verbatim text; the sealed receipt keeps the pointer.
  outputTailSha?: string;
  // sha256 of the findings log this gate wrote to stdout, when it wrote one
  // (ledger D14) — the same hash settle's kept file carries and the umbrella's
  // receipt predicate cites. Absent for every gate that printed something else,
  // and canonicalJson drops undefined, so a receipt without an artifact hashes
  // exactly as it did before the field existed.
  artifactSha?: string;
}

// Tri-state-plus-partial audit record: 'pass'/'partial'/'fail' relay the
// auditor's verdicts verbatim; 'skip' records "never adjudicated" (auditor
// outage, egress exhaustion) — distinguishable from "checked and failed".
export interface AuditRecord {
  check: string;
  verdict: 'pass' | 'partial' | 'fail' | 'skip';
  reasons: string[];
}

export interface ReceiptFacts {
  node: string;
  source: string;
  status: Verdict['status'];
  attempts: number;
  provider: string;
  model?: string;
  gates: GateRecord[]; // final attempt, ladder order
  audit?: AuditRecord[]; // absent when the audit never dispatched
  // The node's acceptance AS RUN — the evolution-invalidation record. A later
  // run whose plan carries different strings must not skip-trust this close.
  acceptance: { smoke?: string; audit?: string };
  degraded: string[]; // every check the plan never configured
  stagedFiles: number;
  telemetry: Verdict['telemetry'];
  durationMs: number;
  contractVersion: string;
  pleachVersion: string;
}

// Mint stamps contractVersion itself — callers cannot mint under a foreign fence.
export type MintFacts = Omit<ReceiptFacts, 'contractVersion'>;

export type DerivedStatus = 'publishable' | 'quarantined';

export interface Receipt {
  facts: ReceiptFacts;
  derived: DerivedStatus;
  sha256: string; // over canonicalJson({facts, derived}) — nothing else
  // Outside the integrity envelope: settled after the freeze, bound by git.
  refs?: {
    diffRef?: string;
    quarantineBranch?: string;
    quarantineSha?: string;
    // The receipt this write replaced (a retried node) — the settle trail
    // survives the overwrite without receipt-chaining infrastructure.
    previousReceiptSha256?: string;
  };
  // The gate artifacts settle kept, as paths — never content (D14). Outside
  // the envelope for the same reason refs are: they are written after the
  // freeze. The integrity claim is the sealed `gates[].artifactSha`; a path is
  // only a place to look, and a moved file cannot forge its own hash.
  artifacts?: {
    sarif?: string;
    friction?: string;
    // The message the worker handed the work back with (D17), verbatim.
    handback?: string;
  };
}

export type Derivation = { ok: true; status: DerivedStatus } | { ok: false; reason: string };

// Sorted-key recursive serialization: the same value always hashes the same,
// whatever property-insertion order produced it. Arrays keep their order —
// gate ladder order is a fact.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalize(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// How much of a receipt's hash names its close (D17). A node id runs more than
// once — a retry, an acceptance-evolution re-dispatch, a resumed quarantine —
// and each of those closes is a record of its own, so the store files every one
// under its own hash beside the latest. Twelve hex digits is what the CLI and
// the journal already print: short enough to read, long enough that a node's
// own closes never collide.
const PREFIX_LENGTH = 12;

export function receiptPrefix(sha256: string): string {
  return sha256.slice(0, PREFIX_LENGTH);
}

// What the facts imply, recomputable by anyone holding them. 'partial' audit
// verdicts do NOT block — the auditor relays them and tend adjudicates (the
// dual close); 'fail' and 'skip' both block, because "never adjudicated" must
// gate exactly as hard as "checked and failed".
export function deriveStatus(facts: ReceiptFacts): Derivation {
  if (facts.contractVersion !== CONTRACT_VERSION) {
    return {
      ok: false,
      reason: `contract version fence: receipt minted under v${facts.contractVersion}, current is v${CONTRACT_VERSION}`,
    };
  }
  return { ok: true, status: deriveCore(facts) };
}

function deriveCore(facts: MintFacts): DerivedStatus {
  if (facts.status !== 'done') return 'quarantined';
  if (facts.gates.some((g) => g.exitCode !== 0)) return 'quarantined';
  if (facts.audit?.some((a) => a.verdict === 'fail' || a.verdict === 'skip')) {
    return 'quarantined';
  }
  return 'publishable';
}

export function mintReceipt(mintFacts: MintFacts): Receipt {
  const facts: ReceiptFacts = { ...mintFacts, contractVersion: CONTRACT_VERSION };
  const derived = deriveCore(facts);
  return { facts, derived, sha256: receiptHash(facts, derived) };
}

export function receiptHash(facts: ReceiptFacts, derived: DerivedStatus): string {
  return sha256Hex(canonicalJson({ facts, derived }));
}

// True iff the envelope still hashes to its seal. Refs are not consulted.
export function rehash(receipt: Receipt): boolean {
  return receiptHash(receipt.facts, receipt.derived) === receipt.sha256;
}

// "No coverage is not coverage" as a recorded fact: every check the plan
// never configured. Plan introspection only — near-zero cost.
export function computeDegraded(node: {
  accept: { smoke?: string; audit?: { command: string; [k: string]: unknown } | undefined };
}): string[] {
  const out: string[] = [];
  if (node.accept.smoke === undefined) out.push('smoke:unconfigured');
  if (node.accept.audit === undefined) out.push('audit:unconfigured');
  return out;
}
