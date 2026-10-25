// Close receipts (§D) — the honesty ledger's pure heart. A receipt freezes
// the facts the conductor actually held at classify time, derives what those
// facts imply, and seals both under a sha256 the node commit's trailer pins
// into immutable git history.
//
// The freeze point is load-bearing: a verifier that hashes facts appended after
// derivation will accuse an honest receipt of forgery. Facts freeze
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
import type { Redaction } from './redact.ts';

// Pinned to the canonical doc's header (docs/contract/plan-schema.md); the
// unit test asserts the pin. A receipt is minted under this version.
export const CONTRACT_VERSION = '1.1.6';

// The contract follows semantic versioning from v1.1.5, where receipts began.
// A minor or a patch stays compatible and never changes how a receipt
// derives, so the fence compares the major only. A change to `deriveCore` is
// an incompatible change and bumps the major; a test pins `deriveCore` to the
// major it belongs to. A receipt from another major fails derivation honestly
// ("wrong contract version"), never mysteriously.
function majorOf(version: string): string | undefined {
  return /^(\d+)\.\d+\.\d+$/.exec(version)?.[1];
}

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
  // The tree this close was seeded from instead of building its own (D17): the
  // quarantined tree a re-adjudication judged or a resumed run continued, at
  // the sha it was taken at, so a close that stood on work an earlier attempt
  // left behind stays distinguishable from a fresh one forever. Sealed
  // INSIDE the envelope, because what was judged is a fact of the close and not
  // a ref settled after the freeze; `canonicalJson` drops undefined, so a
  // receipt that built its own tree hashes exactly as it did before the field.
  // `sha` is the tip actually stood on; `moved` (present only when true) marks
  // a resume whose tip had moved PAST the sha its receipt recorded — a
  // conductor's commit on top of the quarantined tree, kept rather than
  // rebuilt, so a resumed close that carried that fix stays distinguishable
  // from one that stood on the tree exactly as it was quarantined.
  // `land-rebuild` (issue #116) is the same fact for a node rebuilt on the
  // stack a land conflict pinned it at: `sha` is the stack commit.
  base?:
    | { kind: 'quarantine'; sha: string; moved?: boolean }
    | { kind: 'land-rebuild'; sha: string };
  // How far the tree this close held got through a phased work list (D13): the
  // index of the red phase whose seal is IN that tree's history. A later
  // attempt standing on that tree — a resumed quarantine, a re-adjudication
  // (D17) — re-enters the ladder after it, because a tree that already carries
  // the failing test can never honestly seal it again. Absent for work with no
  // phases and for a tree that never got a red through. Sealed INSIDE the
  // envelope for the same reason `base` is: it is a fact of what the close
  // held, and an index edited afterwards would skip a red phase. `canonicalJson`
  // drops undefined, so a receipt without it hashes exactly as it did before
  // the field existed.
  redSealedAt?: number;
  // The node's acceptance AS RUN — the evolution-invalidation record. A later
  // run whose plan carries different strings must not skip-trust this close.
  acceptance: { smoke?: string; audit?: string };
  // The audit command this close actually ran, recorded so a later `pleach
  // audit` can tell "the same question re-asked" (refused) from "a changed
  // audit" (allowed) when the latest close was itself a re-audit (D17). Absent
  // for a node with no audit and for a receipt minted before the field existed
  // — 'unknown', which a re-audit may cross once. `canonicalJson` drops
  // undefined, so a receipt without it hashes exactly as it did before the
  // field existed.
  auditCommand?: string;
  degraded: string[]; // every check the plan never configured
  stagedFiles: number;
  telemetry: Verdict['telemetry'];
  durationMs: number;
  contractVersion: string;
  pleachVersion: string;
  // Whether this close's text was redacted before it reached disk, and by
  // whom (`plotplot`) or not at all (`off` — an explicit `--no-redact`). Sealed
  // INSIDE the envelope: a close that redacted nothing must say so forever.
  redaction: Redaction;
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
    // The verified commit's stable patch-id (git patch-id --stable over its
    // diff) and its committer timestamp (the close time), both read from git at
    // settle (issue #105). They let verify re-locate the work on the landed
    // history after a rebase or squash — the patch-id is stable under a rebase
    // and the timestamp bounds the search with `--since`. Absent for a receipt
    // minted before this change, which verifies exactly as it did.
    patchId?: string;
    closedAt?: number;
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
  const major = majorOf(facts.contractVersion);
  if (major === undefined || major !== majorOf(CONTRACT_VERSION)) {
    return {
      ok: false,
      reason: `contract version fence: receipt minted under v${facts.contractVersion}, this build derives v${majorOf(CONTRACT_VERSION)}.x receipts`,
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

// A commit on the landed history whose patch-id matched, with its message to
// check the trailer against.
export interface LandedCandidate {
  sha: string;
  message: string;
}

// The landed-history decision (issue #105): where a receipt's work sits on the
// current branch, chosen from the commits whose stable patch-id equals the
// receipt's recorded `refs.patchId`. Pure — the git walk lives in the isolate
// seam; this maps the candidate list to the one honest outcome, and never
// guesses when the mapping is ambiguous.
export type LandedDecision =
  | { outcome: 'pass'; landedAs?: string; resolvedBy?: 'patch-id'; trailer?: boolean }
  | { outcome: 'orphaned'; detail: string };

export function chooseLanded(
  patchId: string,
  receiptSha256: string,
  diffRefResolved: boolean,
  candidates: LandedCandidate[],
): LandedDecision {
  const carriesTrailer = (c: LandedCandidate): boolean =>
    c.message.includes(`receipt-sha256: ${receiptSha256}`);
  // The close already passed on its own ref (the trailer matched): the patch-id
  // only reports where the work landed on THIS branch, when exactly one commit
  // carries it. Zero or several → no claim about a landing, still a pass.
  if (diffRefResolved) {
    if (candidates.length === 1) return { outcome: 'pass', landedAs: candidates[0].sha };
    return { outcome: 'pass' };
  }
  // The ref no longer resolves: the patch-id is the only way to the work. One
  // commit carrying the patch is the commit (plotplot#54); whether it also
  // carries the receipt's trailer is reported beside it, since a squash or a
  // rewritten message drops the trailer and keeps the patch.
  if (candidates.length === 1) {
    const only = candidates[0] as LandedCandidate;
    return {
      outcome: 'pass',
      landedAs: only.sha,
      resolvedBy: 'patch-id',
      trailer: carriesTrailer(only),
    };
  }
  if (candidates.length === 0) {
    return {
      outcome: 'orphaned',
      detail: `no commit on the landed history carries patch-id ${patchId} — the work is orphaned`,
    };
  }
  return {
    outcome: 'orphaned',
    detail: `${candidates.length} commits carry patch-id ${patchId} (${candidates
      .map((c) => c.sha)
      .join(', ')}) — ambiguous, refusing to guess`,
  };
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
