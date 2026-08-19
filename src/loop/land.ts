import { LandBlockedError, LandConflictError, RebuildRequiredError } from '../core/errors.ts';
import type { Plan } from '../core/plan.ts';
import { sinkIds, validatePlan } from '../core/validate.ts';
import type { ConductorDeps, LandStack } from './deps.ts';
import { resolveBaseRef, seedClosure } from './run-plan.ts';
import { guardedExec } from './run-work.ts';

// ── land: the last mile (ledger B3) ──────────────────────────────────────────
//
// Verified work sits on node/<id> branches; landPlan merges the plan's sinks
// onto the branch checked out in repoRoot. Policy lives here — every plan node
// must be verified-closed, sinks resolve through the B1/C5 baseRef chain — and
// the git mechanics live in the isolate seam's land(), which builds the merges
// in a throwaway worktree and only ever touches the checkout via --ff-only.
// Composes injected seams only; holds the (repo, source) conductor lock.

export interface LandOpts {
  repoRoot: string;
}

export interface LandSummary {
  branch: string;
  sha: string;
  landed: string[];
}

export async function landPlan(
  plan: Plan,
  deps: ConductorDeps,
  opts: LandOpts,
): Promise<LandSummary> {
  validatePlan(plan); // throws PlanInvalidError — the face maps exit 2.

  const lock = await deps.lock.acquire(opts.repoRoot, plan.source);
  try {
    await deps.journal.append({ event: 'land-start', goal: plan.goal });

    // Defensive copy (M3), then the same implied-ancestor closure as runPlan.
    const closed = new Map<string, string | null>(await deps.ledger.readClosed(plan.source));
    seedClosure(plan, closed);

    // Landing is all-or-nothing: half a plan on the branch would break the
    // verified-only invariant the node branches exist to protect.
    const unclosed = plan.nodes.filter((n) => !closed.has(n.id)).map((n) => n.id);
    if (unclosed.length > 0) {
      await deps.journal.append({ event: 'land-blocked', unverified: unclosed });
      throw new LandBlockedError(`unverified node(s): ${unclosed.join(', ')}`);
    }

    // Resolve each sink through the baseRef chain — a vanished ref is a
    // rebuild, a force-moved branch is refused (C5 verify-before-use).
    const sinks = sinkIds(plan);
    const refs: string[] = [];
    for (const id of sinks) {
      const resolved = await resolveBaseRef(deps, opts.repoRoot, id, closed.get(id) ?? null);
      if (resolved === null) {
        await deps.journal.append({ event: 'rebuild-required', node: id });
        throw new RebuildRequiredError(id);
      }
      refs.push(resolved);
    }

    let landed: { branch: string; sha: string };
    try {
      landed = await gateAndPublish(plan, deps, opts.repoRoot, sinks, refs);
    } catch (err) {
      // A refused land must be explainable from the journal alone.
      if (err instanceof LandConflictError) {
        await deps.journal.append({ event: 'land-conflict', ref: err.ref, files: err.files });
      } else if (err instanceof LandBlockedError) {
        await deps.journal.append({ event: 'land-blocked', reason: err.reason });
      }
      throw err;
    }
    await deps.journal.append({
      event: 'landed',
      branch: landed.branch,
      sha: landed.sha,
      nodes: sinks,
    });
    return { branch: landed.branch, sha: landed.sha, landed: sinks };
  } finally {
    await lock.release();
  }
}

// ── the land gate (§A: verify the composition, refuse-all, name the culprit) ──
//
// Nodes verify on their own merged-from-deps trees; the landed COMBINATION of
// sinks is gated here, in the throwaway stack worktree, before the ff-only
// publish. Gate = the union of the sinks' own declared smoke commands (deduped
// by exact string — the combination must satisfy each constituent's
// acceptance); one flaky retry of the failing command; then a cumulative-
// context bisect over the sinks whose only product is the CULPRIT DIAGNOSTIC —
// policy stays refuse-all. Gate commands may WRITE to the stack worktree (a
// verifier stamping its page is by design); no clean-tree assertion, ever.

const LAND_GATE_TIMEOUT_MS = 1_800_000; // per-command wall clock (30m)

interface GateCommand {
  command: string;
  owners: string[]; // sink ids declaring this exact smoke string
  timeoutMs: number;
}

function collectLandGate(plan: Plan, sinks: readonly string[]): GateCommand[] {
  const byCommand = new Map<string, GateCommand>();
  for (const id of sinks) {
    const node = plan.nodes.find((n) => n.id === id);
    const smoke = node?.accept.smoke;
    if (node === undefined || smoke === undefined) continue;
    const existing = byCommand.get(smoke);
    if (existing) {
      existing.owners.push(id);
    } else {
      byCommand.set(smoke, {
        command: smoke,
        owners: [id],
        timeoutMs: node.policy.timeoutMs ?? LAND_GATE_TIMEOUT_MS,
      });
    }
  }
  return [...byCommand.values()];
}

interface GateFailure {
  command: string;
  outputTail: string;
}

// Run every gate command in the stack cwd; first red stops the pass.
async function runGate(
  deps: ConductorDeps,
  cwd: string,
  gate: readonly GateCommand[],
): Promise<GateFailure | null> {
  for (const g of gate) {
    const { output, exitCode } = await guardedExec(deps.exec, g.command, {
      cwd,
      timeoutMs: g.timeoutMs,
    });
    if (exitCode !== 0) return { command: g.command, outputTail: output.slice(-2000) };
  }
  return null;
}

// Build a stack for a subset of refs, gate it, dispose — one bisect probe.
async function probe(
  deps: ConductorDeps,
  repoRoot: string,
  refs: readonly string[],
  gate: readonly GateCommand[],
): Promise<GateFailure | null> {
  if (refs.length === 0) return null;
  const stack = await deps.isolate.landStack(repoRoot, refs);
  try {
    return await runGate(deps, stack.cwd, gate);
  } finally {
    await stack.dispose();
  }
}

async function gateAndPublish(
  plan: Plan,
  deps: ConductorDeps,
  repoRoot: string,
  sinks: readonly string[],
  refs: readonly string[],
): Promise<{ branch: string; sha: string }> {
  const gate = collectLandGate(plan, sinks);
  const stack: LandStack = await deps.isolate.landStack(repoRoot, refs);
  try {
    if (gate.length > 0) {
      await deps.journal.append({
        event: 'land-gate',
        commands: gate.map((g) => g.command),
        sinks: [...sinks],
      });
      let red = await runGate(deps, stack.cwd, gate);
      if (red !== null) {
        // One flaky retry of the failing command only (don't blame an
        // innocent sink for a flaky suite).
        await deps.journal.append({ event: 'land-gate-retry', command: red.command });
        const g = gate.find((x) => x.command === red?.command) as GateCommand;
        const retry = await guardedExec(deps.exec, g.command, {
          cwd: stack.cwd,
          timeoutMs: g.timeoutMs,
        });
        red =
          retry.exitCode === 0
            ? null
            : { command: g.command, outputTail: retry.output.slice(-2000) };
      }
      if (red !== null) {
        await refuseWithDiagnosis(deps, repoRoot, sinks, refs, gate, red);
      }
    }
    return await stack.publish();
  } finally {
    await stack.dispose();
  }
}

// The bisect: identify culprit sink(s) via subset stacks with cumulative
// context (each right half retests atop the known-good prefix, so order-
// dependent interactions are caught), verify the diagnosis is coherent, and
// REFUSE with the story. Always throws LandBlockedError.
async function refuseWithDiagnosis(
  deps: ConductorDeps,
  repoRoot: string,
  sinks: readonly string[],
  refs: readonly string[],
  gate: readonly GateCommand[],
  fullRed: GateFailure,
): Promise<never> {
  const sinkByRef = new Map(refs.map((r, i) => [r, sinks[i] as string]));
  const culprits: string[] = [];
  let culpritEvidence = fullRed;

  if (refs.length === 1) {
    culprits.push(sinks[0] as string);
  } else {
    const knownGood: string[] = [];
    // Iterative halving over the remaining candidates.
    async function bisect(cands: readonly string[]): Promise<void> {
      if (cands.length === 0) return;
      if (cands.length === 1) {
        culprits.push(sinkByRef.get(cands[0] as string) as string);
        return;
      }
      const mid = Math.ceil(cands.length / 2);
      const left = cands.slice(0, mid);
      const right = cands.slice(mid);
      await deps.journal.append({
        event: 'land-bisect',
        testing: left.map((r) => sinkByRef.get(r)),
        context: knownGood.map((r) => sinkByRef.get(r)),
      });
      const leftRed = await probe(deps, repoRoot, [...knownGood, ...left], gate);
      if (leftRed === null) {
        knownGood.push(...left);
        await bisect(right);
        return;
      }
      culpritEvidence = leftRed;
      await bisect(left);
      // The right half gets its own combined test in known-good context — a
      // left culprit does not exonerate the right half.
      const rightRed = await probe(deps, repoRoot, [...knownGood, ...right], gate);
      if (rightRed !== null) {
        culpritEvidence = rightRed;
        await bisect(right);
      } else {
        knownGood.push(...right);
      }
    }
    await bisect(refs);

    // Terminal coherence check: the good subset alone must pass, or the
    // diagnosis cannot be trusted — say so instead of naming names.
    const goodRefs = refs.filter((r) => !culprits.includes(sinkByRef.get(r) as string));
    const recheck = await probe(deps, repoRoot, goodRefs, gate);
    if (recheck !== null) {
      await deps.journal.append({
        event: 'land-integrity-failed',
        command: recheck.command,
        outputTail: recheck.outputTail,
      });
      throw new LandBlockedError(
        `land gate failed and the diagnosis is incoherent (the culprit-free subset also fails ` +
          `'${recheck.command}') — nothing lands; see the journal`,
      );
    }
  }

  for (const culprit of culprits) {
    await deps.journal.append({
      event: 'land-culprit',
      node: culprit,
      command: culpritEvidence.command,
      outputTail: culpritEvidence.outputTail,
    });
  }
  throw new LandBlockedError(
    `land gate failed on the composition — culprit sink(s): ${culprits.join(', ')} ` +
      `('${culpritEvidence.command}' red on the stack); nothing lands`,
  );
}
