import {
  LandBlockedError,
  LandConflictError,
  PlanInvalidError,
  RebuildRequiredError,
} from '../core/errors.ts';
import type { Plan } from '../core/plan.ts';
import { sinkIds, validatePlan } from '../core/validate.ts';
import type { ConductorDeps, LandStack } from './deps.ts';
import { resolveBaseRef, seedClosure } from './run-plan.ts';
import { guardedExec } from './run-work.ts';

// ── land: the last mile (ledger B3) ──────────────────────────────────────────
//
// Verified work sits on node/<id> branches; landPlan merges the plan's sinks
// onto the branch checked out in repoRoot. Policy lives here — every plan node
// must be verified-closed (with --sinks, exactly the named ones, which then
// ARE the landing's sinks), sinks resolve through the B1/C5 baseRef chain — and
// the git mechanics live in the isolate seam's land(), which builds the merges
// in a throwaway worktree and only ever touches the checkout via --ff-only.
// Composes injected seams only; holds the (repo, source) LAND lock — never the
// run's (D18), so a landing proceeds while the run is still gating other nodes.

export interface LandOpts {
  repoRoot: string;
  // The operator's subset (D18): land exactly these verified ids as the
  // landing's sinks. Absent = the plan's own sinks, all-or-nothing.
  sinks?: string[];
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

  // Which sinks this landing is for — a plan question, answered before any
  // lock is taken or any ledger read.
  const sinks = landingSinks(plan, opts.sinks);

  const lock = await deps.lock.acquireLand(opts.repoRoot, plan.source);
  try {
    await deps.journal.append({ event: 'land-start', goal: plan.goal, sinks });

    // Defensive copy (M3), then the same implied-ancestor closure as runPlan.
    const closed = new Map<string, string | null>(await deps.ledger.readClosed(plan.source));
    seedClosure(plan, closed);

    // Landing is all-or-nothing over what it is landing: the whole plan by
    // default (half a plan on the branch would break the verified-only
    // invariant the node branches exist to protect), or exactly the named
    // subset — the operator's answer to a settled node stranded behind the
    // rest of the run. Either way the refusal names the unverified ids, and
    // it lands before anything is built.
    const scope = opts.sinks === undefined ? plan.nodes.map((n) => n.id) : sinks;
    const unclosed = scope.filter((id) => !closed.has(id));
    if (unclosed.length > 0) {
      await deps.journal.append({ event: 'land-blocked', unverified: unclosed });
      throw new LandBlockedError(`unverified node(s): ${unclosed.join(', ')}`);
    }

    // Resolve each sink through the baseRef chain — a vanished ref is a
    // rebuild, a force-moved branch is refused (C5 verify-before-use).
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

// The landing's sinks: the operator's named subset (D18) or the plan's own.
// A named id that is no node of the plan is a plan-level refusal — nothing the
// ledger says can make it landable, so it never reaches the lock.
function landingSinks(plan: Plan, named: readonly string[] | undefined): string[] {
  if (named === undefined) return sinkIds(plan);
  const ids = new Set(plan.nodes.map((n) => n.id));
  const unknown = named.filter((id) => !ids.has(id));
  if (unknown.length > 0) {
    throw new PlanInvalidError([`--sinks names node(s) not in the plan: ${unknown.join(', ')}`]);
  }
  return [...new Set(named)];
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

// The stack's provisioning (D9): the sinks' own setup commands, deduped by
// exact string — a sink's smoke assumed its setup had run, and work worktrees
// get that post-isolate while the gate's throwaway stack got nothing (decker
// wave 1: `npx vitest` red on a green composition; the bisect named innocent
// sinks). Provisioning lives HERE, never in acceptance text — encoding an
// install into accept.smoke changes acceptance identity and re-dispatches
// every verified node via the acceptance-evolution cascade.
function collectSetupFor(plan: Plan, ids: readonly string[]): GateCommand[] {
  const byCommand = new Map<string, GateCommand>();
  for (const id of ids) {
    const node = plan.nodes.find((n) => n.id === id);
    if (node === undefined || node.setup === undefined) continue;
    const existing = byCommand.get(node.setup);
    if (existing) {
      existing.owners.push(id);
    } else {
      byCommand.set(node.setup, {
        command: node.setup,
        owners: [id],
        timeoutMs: node.policy.timeoutMs ?? LAND_GATE_TIMEOUT_MS,
      });
    }
  }
  return [...byCommand.values()];
}

// A red setup is an ENVIRONMENT failure, not a composition failure — journal
// it and refuse without ever entering the bisect (no innocent culprits).
async function provisionOrRefuse(
  deps: ConductorDeps,
  cwd: string,
  setups: readonly GateCommand[],
  context: string,
): Promise<void> {
  for (const s of setups) {
    const { output, exitCode } = await guardedExec(deps.exec, s.command, {
      cwd,
      timeoutMs: s.timeoutMs,
    });
    if (exitCode !== 0) {
      await deps.journal.append({
        event: 'land-setup-failed',
        command: s.command,
        exitCode,
        outputTail: output.slice(-2000),
      });
      throw new LandBlockedError(
        `land ${context} setup failed ('${s.command}' exited ${exitCode}) — an environment ` +
          `failure, not a composition failure; no culprit named, nothing lands`,
      );
    }
  }
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

// Build a stack for a subset of refs, provision it, gate it, dispose — one
// bisect probe. A probe whose SETUP fails throws (diagnosis untrusted).
async function probe(
  deps: ConductorDeps,
  repoRoot: string,
  refs: readonly string[],
  gate: readonly GateCommand[],
  setups: readonly GateCommand[],
): Promise<GateFailure | null> {
  if (refs.length === 0) return null;
  const stack = await deps.isolate.landStack(repoRoot, refs);
  try {
    await provisionOrRefuse(deps, stack.cwd, setups, 'bisect-probe');
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
  const setups = collectSetupFor(plan, sinks);
  const stack: LandStack = await deps.isolate.landStack(repoRoot, refs);
  try {
    if (gate.length > 0) {
      if (setups.length > 0) {
        await deps.journal.append({
          event: 'land-setup',
          commands: setups.map((s) => s.command),
        });
        await provisionOrRefuse(deps, stack.cwd, setups, 'gate');
      }
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
        await refuseWithDiagnosis(plan, deps, repoRoot, sinks, refs, gate, red);
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
  plan: Plan,
  deps: ConductorDeps,
  repoRoot: string,
  sinks: readonly string[],
  refs: readonly string[],
  gate: readonly GateCommand[],
  fullRed: GateFailure,
): Promise<never> {
  const sinkByRef = new Map(refs.map((r, i) => [r, sinks[i] as string]));
  // Every probe stack is a fresh worktree — it needs the same provisioning
  // the full stack got, scoped to the sinks actually in the probe.
  const setupsFor = (subset: readonly string[]): GateCommand[] =>
    collectSetupFor(
      plan,
      subset.map((r) => sinkByRef.get(r) as string),
    );
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
      const leftProbe = [...knownGood, ...left];
      const leftRed = await probe(deps, repoRoot, leftProbe, gate, setupsFor(leftProbe));
      if (leftRed === null) {
        knownGood.push(...left);
        await bisect(right);
        return;
      }
      culpritEvidence = leftRed;
      await bisect(left);
      // The right half gets its own combined test in known-good context — a
      // left culprit does not exonerate the right half.
      const rightProbe = [...knownGood, ...right];
      const rightRed = await probe(deps, repoRoot, rightProbe, gate, setupsFor(rightProbe));
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
    const recheck = await probe(deps, repoRoot, goodRefs, gate, setupsFor(goodRefs));
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
