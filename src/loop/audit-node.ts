import {
  AuditRefusedError,
  GateFailedError,
  IsolateCatastrophicError,
  RebuildRequiredError,
} from '../core/errors.ts';
import type { AuditResult, Node, Plan, Verdict } from '../core/plan.ts';
import {
  type AuditRecord,
  computeDegraded,
  type GateRecord,
  type MintFacts,
  mintReceipt,
  sha256Hex,
} from '../core/receipt.ts';
import { DEFAULT_WORKER_PROVIDER, validatePlan } from '../core/validate.ts';
import type { ConductorDeps, Isolation } from './deps.ts';
import { execGateWithRetry, runAuditLadder } from './run-node.ts';
import {
  acceptanceOf,
  DEFAULT_TIMEOUT_MS,
  disposeOrJournal,
  quarantineTree,
  resolveBaseRef,
  seedClosure,
  writeReceiptOrJournal,
} from './run-plan.ts';

// ── audit-node: re-adjudicating a quarantined close (ledger D17) ─────────────
//
// An auditor that hands back something the egress parser cannot read fails a
// node whose build was green: the smoke passed, the diff was clean, and the
// tree is sitting on quarantine/<id>. Until now the only way on was to build
// the whole node again — a relay defect charged as a full node.
//
// `pleach audit <plan> <node>` re-runs the audit and nothing else. The
// quarantined tree is checked out again (dependencies merged exactly as a run
// merges them), setup provisions it, and the SAME ladder run-node uses for its
// last gate judges it. A pass publishes node/<id>; anything else writes a new
// quarantine receipt. Either close is a record of its own, linked to the one it
// followed, and `facts.base` names the tree it judged — so a re-adjudicated
// close is distinguishable from a fresh one forever.
//
// What it will not do is re-adjudicate a build that was never green: the
// preconditions are refusals (typed, exit 1), because an audit verdict over an
// unproven tree is precisely the garbage the gates exist to stop.
//
// Composes injected seams only; holds the (repo, source) conductor lock.

export interface AuditNodeOpts {
  repoRoot: string;
  // Wall clock for the setup gate and the auditor's wait; the node's own
  // policy.timeoutMs wins where it has one, exactly as in a run.
  defaultTimeoutMs?: number;
  idleMs?: number;
  // Teardown signal (D12/D16): an auditor cut off mid-wait settles aborted with
  // its tree kept, rather than leaving a worktree behind.
  signal?: AbortSignal;
  pleachVersion?: string;
}

export interface AuditNodeResult {
  node: string;
  // 'closed' — the audit passed, node/<id> is published, the ledger closed it.
  // 'partial' — it passed and published, and the ledger declined the close.
  // 'quarantined' — it did not pass; nothing is published.
  status: 'closed' | 'partial' | 'quarantined';
  // The published commit, when the close made one.
  sha?: string;
  // This close's own receipt hash — where its record is filed. Absent when the
  // close never got far enough to write one (nothing committed, nothing pinned).
  receipt?: string;
}

// pleach's own findings (a marker scan, a tampered gate) have no exit code of
// their own; -1 is the value the ladder's gate records already carry.
const SCAN_EXIT = -1;
const EVIDENCE_TAIL = 2000;
// A re-audit delivers nothing: the tree is the one the build handed over,
// already committed. The ladder's gate-integrity rule flags what THIS caller
// staged, and this caller stages nothing — see `seedFrom` for the half of SEC4a
// that a re-audit does answer.
const NOTHING_STAGED: readonly string[] = [];

export async function auditNode(
  plan: Plan,
  nodeId: string,
  deps: ConductorDeps,
  opts: AuditNodeOpts,
): Promise<AuditNodeResult> {
  validatePlan(plan); // throws PlanInvalidError — the face maps exit 2.

  const node = plan.nodes.find((n) => n.id === nodeId);
  if (node === undefined) {
    throw new AuditRefusedError(nodeId, 'no node with that id in this plan');
  }
  if (node.accept.audit === undefined) {
    throw new AuditRefusedError(nodeId, 'the node declares no audit — there is no gate to re-run');
  }

  const lock = await deps.lock.acquire(opts.repoRoot, plan.source);
  try {
    return await auditUnderLock(plan, node, deps, opts);
  } finally {
    await lock.release();
  }
}

async function auditUnderLock(
  plan: Plan,
  node: Node,
  deps: ConductorDeps,
  opts: AuditNodeOpts,
): Promise<AuditNodeResult> {
  const seed = await seedFrom(node, deps, opts.repoRoot);
  const baseRefs = await auditBaseRefs(plan, node, deps, opts.repoRoot, seed.sha);
  const timeoutMs = node.policy.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  await deps.journal.append({ event: 'node-start', node: node.id });
  const startedAt = Date.now();

  let iso: Isolation;
  try {
    iso = await deps.isolate.isolate(node, baseRefs);
  } catch (err) {
    if (err instanceof IsolateCatastrophicError) {
      throw new AuditRefusedError(
        node.id,
        `the quarantined tree could not be checked out again: ${err.detail}`,
      );
    }
    throw err;
  }

  // From here a live worktree is held, so every path out of it — a close, a
  // refusal, a throw from the auditor's own seam — goes through one dispose,
  // after the close has finished with the tree (the settle paths commit and
  // quarantine while it is still there). A leaked worktree is how a killed run
  // used to litter a repo (#74).
  const settle: Settle = {
    plan,
    node,
    deps,
    iso,
    base: { kind: 'quarantine', sha: seed.sha },
    ...(seed.redSealedAt !== undefined ? { redSealedAt: seed.redSealedAt } : {}),
    gates: [],
    startedAt,
    pleachVersion: opts.pleachVersion ?? '0.0.0-dev',
  };
  try {
    return await adjudicate(settle, opts, timeoutMs);
  } finally {
    await disposeOrJournal(deps, iso, node.id);
  }
}

async function adjudicate(
  settle: Settle,
  opts: AuditNodeOpts,
  timeoutMs: number,
): Promise<AuditNodeResult> {
  const { deps, node, iso } = settle;

  // A dependency that moved since the build can conflict with the quarantined
  // tree. Resolving a merge is work, and work belongs to a run — refuse before
  // an auditor turn is spent on a tree full of markers. The quarantine stands.
  if (iso.conflictFiles.length > 0) {
    throw new AuditRefusedError(
      node.id,
      `merging its dependencies into the quarantined tree conflicts in: ${iso.conflictFiles.join(', ')} — re-run the node`,
    );
  }

  // ── setup ──────────────────────────────────────────────────────────────────
  // The tree is new, so what the audit command needs installed in it is no more
  // installed than it would be for a run's first attempt.
  if (node.setup) {
    const { output, exitCode } = await execGateWithRetry(deps, node.id, 'setup', node.setup, {
      cwd: iso.cwd,
      timeoutMs,
    });
    const tail = output.slice(-EVIDENCE_TAIL);
    settle.gates.push(gateRecord('setup', exitCode, tail));
    if (exitCode !== 0) {
      return await quarantineClose(
        settle,
        verdictOf(node, 'failed', { ran: node.setup, exitCode }),
        tail,
      );
    }
  }

  // ── the audit ladder, and only it ──────────────────────────────────────────
  const audit = node.accept.audit as NonNullable<Node['accept']['audit']>;
  const ladder = await runAuditLadder(node, iso.cwd, NOTHING_STAGED, deps, timeoutMs, {
    signal: opts.signal,
    idleMs: opts.idleMs,
  });

  if (ladder.kind === 'tampered') {
    // Unreachable while this caller stages nothing — recorded rather than
    // assumed away, because the rule belongs to the ladder and may widen.
    settle.gates.push({ gate: 'audit-tamper', exitCode: SCAN_EXIT });
    const ran = `${audit.command} (gate tampered: ${ladder.files.join(', ')})`;
    return await quarantineClose(settle, verdictOf(node, 'failed', { ran, exitCode: SCAN_EXIT }));
  }

  settle.records = ladder.records;

  if (ladder.kind === 'unadjudicated') {
    // The auditor never spoke: its egress never parsed, or it died, timed out,
    // or the run's own signal cut it off (that last one is an abort, not a
    // failed audit — the tree rides back either way).
    const verdict = verdictOf(node, ladder.aborted ? 'aborted' : 'failed', {
      ran: ladder.gateRan,
      exitCode: SCAN_EXIT,
    });
    return await quarantineClose(settle, verdict);
  }

  if (ladder.kind === 'fail') {
    // Checked and refused: the verdicts carry the reasons, so no gate record
    // speaks for them (the receipt relays them verbatim — §D).
    return await quarantineClose(settle, verdictOf(node, 'failed'));
  }

  return await publishClose(settle, ladder.result);
}

// ── the close that stands on a quarantine ────────────────────────────────────

interface Settle {
  plan: Plan;
  node: Node;
  deps: ConductorDeps;
  iso: Isolation;
  base: { kind: 'quarantine'; sha: string };
  // What the tree being judged got through of a phased work list (D13), as the
  // close that kept it recorded — carried, never recomputed.
  redSealedAt?: number;
  gates: GateRecord[];
  records?: AuditRecord[];
  startedAt: number;
  pleachVersion: string;
}

// A pass: commit-before-emit (B2). node/<id> and its SHA exist before the
// ledger is told anything, and the receipt's hash rides in the commit's trailer
// — the freeze point is before the commit, so git binds the two, not the hash.
async function publishClose(settle: Settle, result: AuditResult): Promise<AuditNodeResult> {
  const { deps, node, plan, iso } = settle;
  const verdict: Verdict = { ...verdictOf(node, 'done'), output: result };
  const durationMs = Date.now() - settle.startedAt;
  await journalVerdict(settle, verdict, durationMs);

  const receipt = mintReceipt(auditFacts(settle, verdict, durationMs));
  let sha: string | undefined;
  let decision: { closed: boolean } | undefined;
  let failure: unknown;
  try {
    // The auditor shared this cwd and may have written markers into it after
    // the gates that would have caught them. A dirty tree FAILS, no commit.
    const markers = await deps.isolate.scanMarkers(iso.cwd);
    if (markers.length > 0) throw new GateFailedError('marker', markers.join('\n'), SCAN_EXIT);
    // Nothing is staged: what this close publishes is the tree the build handed
    // over, judged and now verified — never the auditor's own droppings.
    ({ sha } = await deps.isolate.commitBranch(
      iso.cwd,
      `node/${node.id}`,
      `${closeMessage(settle)}\n\nreceipt-sha256: ${receipt.sha256}`,
    ));
    decision = await deps.ledger.emitVerdict(
      { ...verdict, evidence: { ...verdict.evidence, diffRef: sha } },
      plan.source,
    );
  } catch (err) {
    failure = err;
  }
  if (failure !== undefined || sha === undefined || decision === undefined) {
    // Nothing was published, so nothing pins this receipt: the record of the
    // attempt is the journal's, and the quarantine still holds the tree.
    await deps.journal.append({
      event: 'gate-fail',
      node: node.id,
      gate: failure instanceof GateFailedError ? failure.gate : 'commit',
    });
    await deps.ledger.emitVerdict(verdictOf(node, 'failed'), plan.source);
    // No commit, so nothing pins this receipt and none is written (a receipt
    // whose hash no history carries proves nothing). The tree the re-audit
    // judged is still on its quarantine branch, exactly as it was.
    return { node: node.id, status: 'quarantined' };
  }

  await writeReceiptOrJournal(deps, node.id, { ...receipt, refs: { diffRef: sha } });

  if (decision.closed) {
    await deps.journal.append({
      event: 'closed',
      node: node.id,
      sha,
      ...(receipt.facts.degraded.length > 0 ? { degraded: receipt.facts.degraded } : {}),
    });
    return { node: node.id, status: 'closed', sha, receipt: receipt.sha256 };
  }
  // Published and gated green, but the ledger declined to verify-close it —
  // 'partial', exactly as in a run: nothing broke, it is simply not verified.
  await deps.journal.append({ event: 'not-closed', node: node.id });
  return { node: node.id, status: 'partial', sha, receipt: receipt.sha256 };
}

// Anything else: the tree was judged and refused. The verdict is the record and
// the tree it judged earns a commit of its own on quarantine/<id> — even when
// the re-audit changed nothing in it, because a refusal with no artifact is a
// terminal verdict nobody can resolve back to what it judged (D11).
async function quarantineClose(
  settle: Settle,
  verdict: Verdict,
  tail?: string,
): Promise<AuditNodeResult> {
  const { deps, node, plan, iso } = settle;
  const durationMs = Date.now() - settle.startedAt;
  await journalVerdict(settle, verdict, durationMs, tail);

  const receipt = mintReceipt(auditFacts(settle, verdict, durationMs));
  const refs = await quarantineTree(deps, plan, node, iso, receipt, { allowEmpty: true });
  await writeReceiptOrJournal(deps, node.id, {
    ...receipt,
    ...(refs !== undefined ? { refs } : {}),
  });
  return { node: node.id, status: 'quarantined', receipt: receipt.sha256 };
}

// ── what the verb stands on ──────────────────────────────────────────────────

// The close that quarantined the tree this run is about to judge. Every refusal
// here is a fact about that close, read before anything is spawned or written:
// a re-audit changes no state until the auditor has spoken.
async function seedFrom(
  node: Node,
  deps: ConductorDeps,
  repoRoot: string,
): Promise<{ branch: string; sha: string; redSealedAt?: number }> {
  const receipt = await deps.receipts.read(node.id);
  if (receipt === null) {
    throw new AuditRefusedError(
      node.id,
      'no close receipt on file — nothing says its build was green',
    );
  }
  if (receipt.derived !== 'quarantined') {
    throw new AuditRefusedError(
      node.id,
      `its latest close derived '${receipt.derived}' — only a quarantine is left to re-adjudicate`,
    );
  }
  // The build must have been green: a re-audit adjudicates work, it never
  // excuses a red gate. The smoke is the gate that says the build stands, and
  // no smoke recorded is no such claim.
  const smoke = receipt.facts.gates.find((g) => g.gate === 'smoke');
  if (smoke === undefined || smoke.exitCode !== 0) {
    throw new AuditRefusedError(
      node.id,
      receipt.facts.base !== undefined
        ? 'its latest close was itself a re-audit, which runs no smoke of its own — re-run the node'
        : 'its latest close records no green smoke — an audit verdict over an unproven build proves nothing',
    );
  }
  // The other half of SEC4a: an auditor was already admitted to this exact
  // tree, which is what audit records mean — the gate-integrity check passed on
  // it before that auditor was spawned. A close that never reached the audit (a
  // rewritten gate, an interrupted build) is not one to re-adjudicate.
  if (receipt.facts.audit === undefined) {
    throw new AuditRefusedError(
      node.id,
      'its latest close never reached the audit — re-run the node instead',
    );
  }
  const branch = receipt.refs?.quarantineBranch;
  const recorded = receipt.refs?.quarantineSha;
  if (branch === undefined || recorded === undefined) {
    throw new AuditRefusedError(
      node.id,
      'its latest close kept no tree — there is nothing to seed from',
    );
  }
  // C5 verify-before-use: a worker can reach shared refs from inside a
  // worktree, so a quarantine ref is only usable while it still points where
  // the close that wrote it said it did.
  const sha = await deps.isolate.refSha(repoRoot, branch);
  if (sha === null) {
    throw new AuditRefusedError(
      node.id,
      `${branch} does not resolve — the quarantined tree is gone`,
    );
  }
  if (sha !== recorded) {
    throw new AuditRefusedError(node.id, `${branch} has moved since the close that wrote it`);
  }
  // This close judges the tree that close held, so what that tree got through
  // of a phased list (D13) is still true of it — and stays on the record, for
  // the run that resumes this quarantine if the audit refuses it.
  const { redSealedAt } = receipt.facts;
  return { branch, sha, ...(redSealedAt !== undefined ? { redSealedAt } : {}) };
}

// The isolate bases a run would use, with the quarantined tree in front of
// them: baseRefs[0] is the checkout, the rest are merged (run-plan's
// baseRefsFor). Dependencies resolve through the same B1/C5 chain, so a
// re-audit stands on the same verified work the build stood on — and refuses,
// as a run does, when one of them no longer resolves.
async function auditBaseRefs(
  plan: Plan,
  node: Node,
  deps: ConductorDeps,
  repoRoot: string,
  quarantineSha: string,
): Promise<string[]> {
  if (node.needs.length === 0) return [quarantineSha];
  const closed = new Map<string, string | null>(await deps.ledger.readClosed(plan.source));
  seedClosure(plan, closed);
  const refs = [quarantineSha];
  for (const dep of node.needs) {
    const resolved = await resolveBaseRef(deps, repoRoot, dep, closed.get(dep) ?? null);
    if (resolved === null) {
      await deps.journal.append({ event: 'rebuild-required', node: dep });
      throw new RebuildRequiredError(dep);
    }
    refs.push(resolved);
  }
  return refs;
}

// ── records ──────────────────────────────────────────────────────────────────

function verdictOf(
  node: Node,
  status: Verdict['status'],
  gate?: { ran: string; exitCode: number },
): Verdict {
  return {
    node: node.id,
    status,
    output: undefined,
    // A re-audit touches nothing: the delivery is the build's, already
    // committed on the tree this close judged.
    evidence: { filesTouched: [], ...(gate !== undefined ? { gate } : {}) },
    telemetry: {},
    // One adjudication, spent once — the build's attempts are the build
    // receipt's, and `facts.base` links this close back to them.
    attempts: 1,
  };
}

// The journal keeps the failing gate's verbatim tail; the sealed receipt keeps
// the pointer to it (D10).
function gateRecord(gate: string, exitCode: number, tail: string): GateRecord {
  return {
    gate,
    exitCode,
    ...(exitCode !== 0 && tail.length > 0 ? { outputTailSha: sha256Hex(tail) } : {}),
  };
}

async function journalVerdict(
  settle: Settle,
  verdict: Verdict,
  durationMs: number,
  tail?: string,
): Promise<void> {
  const { node } = settle;
  await settle.deps.journal.append({
    event: 'verdict',
    node: node.id,
    status: verdict.status,
    attempts: verdict.attempts,
    telemetry: verdict.telemetry,
    durationMs,
    provider: node.worker.provider ?? DEFAULT_WORKER_PROVIDER,
    ...(node.worker.model !== undefined ? { model: node.worker.model } : {}),
    ...(verdict.evidence.gate
      ? { gate: { ...verdict.evidence.gate, ...(tail !== undefined ? { outputTail: tail } : {}) } }
      : {}),
    // Which tree this verdict judged — a re-adjudication's verdict is about
    // work some earlier attempt produced, and the journal must say so.
    base: settle.base,
  });
}

// Receipt facts, frozen exactly as a run's settle freezes them — plus the one
// fact that makes this close a re-adjudication rather than a build.
function auditFacts(settle: Settle, verdict: Verdict, durationMs: number): MintFacts {
  const { node, plan } = settle;
  return {
    node: node.id,
    source: plan.source,
    status: verdict.status,
    attempts: verdict.attempts,
    provider: node.worker.provider ?? DEFAULT_WORKER_PROVIDER,
    ...(node.worker.model !== undefined ? { model: node.worker.model } : {}),
    gates: settle.gates,
    ...(settle.records !== undefined ? { audit: settle.records } : {}),
    base: settle.base,
    ...(settle.redSealedAt !== undefined ? { redSealedAt: settle.redSealedAt } : {}),
    acceptance: acceptanceOf(node),
    degraded: computeDegraded(node),
    // The delivery is the build's; this close staged nothing of its own.
    stagedFiles: 0,
    telemetry: verdict.telemetry,
    durationMs,
    pleachVersion: settle.pleachVersion,
  };
}

function closeMessage(settle: Settle): string {
  const { node, plan, base } = settle;
  return `pleach: ${node.id} verified (re-audited)\n\nsource: ${plan.source}\ngoal: ${plan.goal}\nbase: quarantine ${base.sha}`;
}
