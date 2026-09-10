import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import {
  ConfigError,
  LandBlockedError,
  LandConflictError,
  LockHeldError,
  NoRunError,
  PlanInvalidError,
  RebuildRequiredError,
  TendTransportError,
} from '../core/errors.ts';
import { type Plan, PlanSchema } from '../core/plan.ts';
import { receiptPrefix } from '../core/receipt.ts';
import { planJsonSchema } from '../core/schema-json.ts';
import { nodeSummaries, planWarnings, validatePlan } from '../core/validate.ts';
import type { RunSummary } from '../loop/deps.ts';
import { landPlan } from '../loop/land.ts';
import { verifyReceipt } from '../loop/receipt-verify.ts';
import { runPlan } from '../loop/run-plan.ts';
import { sweepOrphanWorktrees, sweepStaleLocks } from '../seams/clean.ts';
import { exec } from '../seams/exec.ts';
import { requestStop, signalRun } from '../seams/lock.ts';
import { buildDeps, receiptDeps, resolveSeams } from './config.ts';
import { narrateEvent } from './narrate.ts';

// The receipt version fence needs the real package version; read it from the
// package.json shipped beside this source. Unreadable → an honest dev marker.
async function pleachVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === 'string' ? v : '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

const HELP = `pleach — deterministic conductor for DAGs of verified agent work

Usage:
  pleach run <plan.json> [flags]     Execute a plan
  pleach land <plan.json> [flags]    Merge a verified plan's sinks onto the checked-out branch
  pleach stop <plan.json> [flags]    Drain a running plan: no new nodes launch, in-flight nodes
                                     settle; --now aborts them (SIGINT to the run)
  pleach validate <plan.json>        Parse + validate a plan; print the topo order
  pleach schema                      Emit the plan contract as JSON Schema (for planners / codegen)
  pleach receipt <node> [flags]      Verify a settled node's close receipt (--repo-root applies)
  pleach clean [flags]               Sweep a killed run's leavings: stale locks + orphaned pleach
                                     worktrees (--repo-root applies). Refuses the worktree sweep
                                     while a LIVE lock exists — a run may be in flight. Worker
                                     sessions are umbel's; list them with \`umbel ls\`.
  pleach --help
  pleach --version

Flags (run):
  --repo-root PATH        Git repo the worktrees and node/<id> branches live in (default: cwd)
  --max-concurrency N     Parallel node cap (default: plan.maxConcurrency, else CPU cores − 2)
  --timeout-ms N          Default per-attempt timeout when a node omits policy.timeoutMs (default: 30m)
  --idle-ms N             End a worker's wait after this long with no activity (default: 10m).
                          A wedged worker (an auditor idle on a 404) settles blocked with its
                          tree quarantined instead of riding the attempt clock.
  --journal PATH          Run journal JSONL (default: <git-dir>/pleach/journal.jsonl)
  --runner NAME           Bundled runner for zero-config runs: 'umbel' (default; interactive
                          CLIs over tmux) or 'direct-cli' (headless \`claude -p\` / \`codex exec\` —
                          no umbel, no tmux, single-turn {prompt} nodes only)
  --umbel-bin PATH        umbel binary (default: $PLEACH_UMBEL_BIN or 'umbel' on PATH)
  --config PATH           pleach.config.ts selecting the runner + ledger
                          (default: <repo-root>/pleach.config.ts if present)
  --tend-module PATH      use the tend ledger via this ingester module ($PLEACH_TEND_MODULE);
                          omit it (with no config) to run standalone on the git ledger (node/<id> branches)
  --allowed-tools LIST    Tool allowlist for claude workers (cannot cover MCP tools)
  --permission-mode MODE  Override the unattended default with an explicit permission mode.
                          Workers spawn unattended (umbel --unattended maps per-provider
                          no-prompt flags; safety is external: disposable worktree + gates +
                          cross-provider audit). Rides claude (any mode) and codex
                          (bypassPermissions only); umbel gives an explicit mode precedence.
  --land                  After a fully-verified close, land the plan (see below); the run
                          summary gains a "land" object. A red run never lands.
  --quiet                 Suppress the per-event narration on stderr (one plain line per
                          node event; a worker blocked on you is shouted). The JSONL
                          journal records everything regardless.

Flags (stop):
  --repo-root PATH        Git repo whose run is drained (default: cwd)
  --now                   Abort the in-flight nodes too: SIGINT to the run's process. Their
                          trees are quarantined as they stand and their receipts written.

Landing: verified work is published as node/<id> branches; \`pleach land\` merges
the plan's sinks onto the branch checked out in --repo-root. It refuses unless
EVERY plan node is verified, and a merge conflict or non-fast-forward aborts
with the repo untouched — resolve those by hand (git merge node/<id>).

Resuming is automatic: re-running a plan skips nodes already verified in the
ledger (their node/<id> branch exists) — only unbuilt or previously-failed
nodes execute. The JSON summary's "alreadyVerified" lists what was skipped.

A 'blocked' node means its worker stopped at a permission/approval prompt. The
session is terminated (nothing to attach to); the prompt text is recorded in
the journal as blockedReason. Fix --permission-mode / --allowed-tools and
re-run. A failed node's uncommitted work is preserved on quarantine/<id> for
inspection (summary field "quarantined"); it is never treated as verified.

Exit codes:
  0  every plan node closed (verified)
  1  one or more nodes failed / partial / blocked / skipped (summary on stdout says which)
  2  usage error, unreadable or invalid plan
  3  lock: another conductor holds this (repo, source) — or, for \`stop\`, no run holds it

Receipts: every close and quarantine mints a sealed receipt (facts frozen at
classify time, sha256 pinned as a receipt-sha256 trailer in the node's commit,
files under <git-dir>/pleach/receipts/ — <node>.<sha256 prefix>.json is that
close's own and <node>.json is whatever closed last, so a node that runs again
keeps both). \`pleach receipt <node>\` re-hashes the latest file, re-derives the
status from its facts, checks the trailer, and lists every close behind it:
PASS (exit 0) · TAMPERED (exit 1) · UNDERIVABLE (exit 2 — nothing proved
either way: no receipt, foreign contract version, or unresolvable ref).
`;

interface Flags {
  repoRoot: string;
  maxConcurrency?: number;
  timeoutMs?: number;
  idleMs: number;
  journal?: string;
  umbelBin: string;
  tendModule?: string;
  allowedTools?: string;
  permissionMode?: string;
  config?: string;
  land: boolean;
  now: boolean;
  quiet: boolean;
  runnerKind?: 'umbel' | 'direct-cli';
}

// The conductor's idle policy (D16): a worker quiet this long has stopped
// working, whatever its attempt clock says. Ten minutes is long enough for a
// slow tool call and short enough that nobody watches a wedged worker for half
// an hour. Per-run override: --idle-ms.
const DEFAULT_IDLE_MS = 10 * 60 * 1000;

class UsageError extends Error {
  readonly name = 'UsageError';
}

function parseFlags(argv: readonly string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = {
    repoRoot: process.cwd(),
    idleMs: DEFAULT_IDLE_MS,
    umbelBin: process.env.PLEACH_UMBEL_BIN ?? 'umbel',
    land: false,
    now: false,
    quiet: false,
  };
  if (process.env.PLEACH_TEND_MODULE !== undefined) {
    flags.tendModule = process.env.PLEACH_TEND_MODULE;
  }
  const takeValue = (name: string, value: string | undefined): string => {
    if (value === undefined) throw new UsageError(`${name} requires a value`);
    return value;
  };
  const takeNumber = (name: string, value: string | undefined): number => {
    const n = Number(takeValue(name, value));
    if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${name} must be a positive number`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const next = argv[i + 1];
    switch (arg) {
      case '--repo-root':
        flags.repoRoot = takeValue(arg, next);
        i += 1;
        break;
      case '--max-concurrency':
        flags.maxConcurrency = takeNumber(arg, next);
        i += 1;
        break;
      case '--timeout-ms':
        flags.timeoutMs = takeNumber(arg, next);
        i += 1;
        break;
      case '--idle-ms':
        flags.idleMs = takeNumber(arg, next);
        i += 1;
        break;
      case '--journal':
        flags.journal = takeValue(arg, next);
        i += 1;
        break;
      case '--umbel-bin':
        flags.umbelBin = takeValue(arg, next);
        i += 1;
        break;
      case '--config':
        flags.config = takeValue(arg, next);
        i += 1;
        break;
      case '--tend-module':
        flags.tendModule = takeValue(arg, next);
        i += 1;
        break;
      case '--allowed-tools':
        flags.allowedTools = takeValue(arg, next);
        i += 1;
        break;
      case '--permission-mode':
        flags.permissionMode = takeValue(arg, next);
        i += 1;
        break;
      case '--land':
        flags.land = true;
        break;
      case '--now':
        flags.now = true;
        break;
      case '--quiet':
        flags.quiet = true;
        break;
      case '--runner': {
        const kind = takeValue(arg, next);
        if (kind !== 'umbel' && kind !== 'direct-cli') {
          throw new UsageError(`--runner must be 'umbel' or 'direct-cli', got '${kind}'`);
        }
        flags.runnerKind = kind;
        i += 1;
        break;
      }
      default:
        throw new UsageError(`unknown flag '${arg}'`);
    }
  }
  return { positionals, flags };
}

async function readPlan(path: string) {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new UsageError(`cannot read plan file '${path}'`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new UsageError(`plan file '${path}' is not valid JSON`);
  }
  const parsed = PlanSchema.safeParse(json);
  if (!parsed.success) {
    throw new PlanInvalidError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return parsed.data;
}

function verbSchema(): number {
  process.stdout.write(`${JSON.stringify(planJsonSchema(), null, 2)}\n`);
  return 0;
}

// Pure: the whole `pleach validate` report — the JSON line for stdout, a line
// per plan warning for stderr, and the exit code. Warnings are advice about a
// valid plan (ledger D13), so the code stays 0 whether or not any fired; only a
// PlanInvalidError (thrown out of here) changes it, at the face's catch.
export function validateReport(plan: Plan): { code: number; stdout: string; stderr: string } {
  const { order, waves } = validatePlan(plan);
  const warnings = planWarnings(plan);
  const summary = { valid: true, order, waves, nodes: nodeSummaries(plan), warnings };
  return {
    code: 0,
    stdout: `${JSON.stringify(summary)}\n`,
    stderr: warnings.map((w) => `pleach: warning: ${w}\n`).join(''),
  };
}

async function verbValidate(planPath: string): Promise<number> {
  const { code, stdout, stderr } = validateReport(await readPlan(planPath));
  process.stdout.write(stdout);
  if (stderr !== '') process.stderr.write(stderr);
  return code;
}

// Pure: map a RunSummary to the process exit code. 0 only when every node closed
// (verified). A 'partial' node — work landed and every gate passed, but tend
// declined to verify-close — is NOT success (the run didn't achieve a verified
// close), so it maps to 1 alongside failed/blocked/skipped. The JSON summary on
// stdout carries the per-bucket breakdown for a caller that must tell them apart.
export function summaryExitCode(summary: RunSummary): number {
  const clean =
    summary.failed.length === 0 &&
    summary.partial.length === 0 &&
    summary.blocked.length === 0 &&
    summary.aborted.length === 0 &&
    summary.skipped.length === 0;
  return clean ? 0 : 1;
}

async function depsFromFlags(flags: Flags) {
  const { runner, ledger } = await resolveSeams({
    repoRoot: flags.repoRoot,
    umbelBin: flags.umbelBin,
    ...(flags.permissionMode !== undefined ? { permissionMode: flags.permissionMode } : {}),
    ...(flags.config !== undefined ? { config: flags.config } : {}),
    ...(flags.allowedTools !== undefined ? { allowedTools: flags.allowedTools } : {}),
    ...(flags.tendModule !== undefined ? { tendModule: flags.tendModule } : {}),
    ...(flags.runnerKind !== undefined ? { runnerKind: flags.runnerKind } : {}),
  });
  return buildDeps({
    repoRoot: flags.repoRoot,
    runner,
    ledger,
    ...(flags.journal !== undefined ? { journal: flags.journal } : {}),
    // The narration floor: every journal event a human should glance at gets
    // one plain stderr line; --quiet silences it (the journal file remains).
    ...(flags.quiet
      ? {}
      : {
          narrate: (event: Record<string, unknown>) => {
            const line = narrateEvent(event);
            if (line !== null) process.stderr.write(`${line}\n`);
          },
        }),
  });
}

async function verbRun(planPath: string, flags: Flags): Promise<number> {
  const plan = await readPlan(planPath);
  const deps = await depsFromFlags(flags);

  // D12: SIGINT/SIGTERM tear the run down instead of orphaning it — workers
  // killed, trees quarantined/disposed, lock released, journal says why. A
  // second signal falls through to the default handler (immediate death).
  const teardown = new AbortController();
  const onSignal = (sig: string) => {
    process.stderr.write(`pleach: ${sig} — aborting run, tearing down\n`);
    teardown.abort();
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  const summary = await runPlan(plan, deps, {
    repoRoot: flags.repoRoot,
    pleachVersion: await pleachVersion(),
    signal: teardown.signal,
    // The contract's conductor default when neither flag nor plan caps it:
    // cores−2, floored at 1 (the loop stays environment-free).
    defaultConcurrency: Math.max(1, cpus().length - 2),
    idleMs: flags.idleMs,
    ...(flags.maxConcurrency !== undefined ? { maxConcurrency: flags.maxConcurrency } : {}),
    ...(flags.timeoutMs !== undefined ? { defaultTimeoutMs: flags.timeoutMs } : {}),
  });

  const code = summaryExitCode(summary);
  // --land: a fully-verified close lands in the same invocation; a red run
  // never lands (the summary alone says why).
  if (flags.land && code === 0) {
    const land = await landPlan(plan, deps, { repoRoot: flags.repoRoot });
    process.stdout.write(`${JSON.stringify({ ...summary, land })}\n`);
    return 0;
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return code;
}

async function verbReceipt(nodeId: string, flags: Flags): Promise<number> {
  const check = await verifyReceipt(nodeId, receiptDeps(flags.repoRoot), flags.repoRoot);
  const receipt = 'receipt' in check ? check.receipt : undefined;
  const degraded = receipt?.facts.degraded ?? [];

  if (check.outcome === 'pass' && receipt !== undefined) {
    process.stderr.write(
      `pleach: receipt PASS — ${nodeId} ${receipt.derived} (receipt-sha256 ${receiptPrefix(receipt.sha256)}…)\n`,
    );
    for (const d of degraded) process.stderr.write(`pleach:   degraded: ${d}\n`);
  } else if (check.outcome !== 'pass') {
    process.stderr.write(
      `pleach: receipt ${check.outcome.toUpperCase()} — ${nodeId}: ${check.detail}\n`,
    );
  }
  // Every close before this one (D17), newest first — the verdict above is the
  // latest close's; these are what the node closed as on the way there.
  for (const prior of check.history) {
    process.stderr.write(
      'missing' in prior
        ? `pleach:   previous ${receiptPrefix(prior.sha256)}… — no receipt file for it in the store\n`
        : `pleach:   previous ${receiptPrefix(prior.sha256)}… ${prior.status} ${prior.derived}\n`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      node: nodeId,
      outcome: check.outcome,
      ...(receipt !== undefined
        ? { derived: receipt.derived, sha256: receipt.sha256, degraded }
        : {}),
      history: check.history,
      ...(check.outcome !== 'pass' ? { detail: check.detail } : {}),
    })}\n`,
  );
  return check.outcome === 'pass' ? 0 : check.outcome === 'tampered' ? 1 : 2;
}

async function verbLand(planPath: string, flags: Flags): Promise<number> {
  const plan = await readPlan(planPath);
  const deps = await depsFromFlags(flags);
  const land = await landPlan(plan, deps, { repoRoot: flags.repoRoot });
  process.stderr.write(`pleach: landed ${land.landed.join(', ')} on '${land.branch}'\n`);
  process.stdout.write(`${JSON.stringify(land)}\n`);
  return 0;
}

// D16: drain a running plan. The marker goes beside the run's lock — through the
// seam, which owns that path and the pid it names — so the run's very next
// launch decision sees it: nothing more starts, in-flight nodes settle. --now
// adds the hard abort on top, which is the aborted path (receipt + quarantine),
// not a kill. The face never signals by itself.
async function verbStop(planPath: string, flags: Flags): Promise<number> {
  const { source } = await readPlan(planPath);
  const pid = await requestStop(flags.repoRoot, source);
  process.stdout.write(
    `stop requested for '${source}' — run pid ${pid} launches no more nodes; in-flight nodes settle\n`,
  );
  if (flags.now) {
    await signalRun(flags.repoRoot, source, 'SIGINT');
    process.stdout.write(`SIGINT sent to run pid ${pid} — in-flight nodes abort\n`);
  }
  return 0;
}

// D12 (bandung P5): sweep a killed run's leavings. Stale locks always clear;
// the worktree sweep refuses while any LIVE lock exists — a run may be in
// flight, and cleaning under it would be the tmux-kill-server lesson replayed.
async function verbClean(flags: Flags): Promise<number> {
  const { removed, live } = await sweepStaleLocks(flags.repoRoot);
  for (const path of removed) process.stdout.write(`removed stale lock ${path}\n`);
  if (live.length > 0) {
    for (const path of live) process.stdout.write(`live lock ${path} — a run may be in flight\n`);
    process.stdout.write('worktree sweep refused while a live lock exists\n');
    return 3;
  }
  const worktrees = await sweepOrphanWorktrees(exec, flags.repoRoot);
  for (const path of worktrees) process.stdout.write(`removed orphaned worktree ${path}\n`);
  if (removed.length === 0 && worktrees.length === 0) {
    process.stdout.write('nothing to clean\n');
  }
  return 0;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  try {
    // Help rides ahead of flag parsing — parseFlags rejects unknown flags, and
    // the one flag every user tries first must never be "unknown" (ledger D-help).
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(HELP);
      return 0;
    }

    // Same rule as help (P6a): a bed's garden.lock needs a version for every
    // judge, and the flag every tool tries must never be "unknown".
    if (argv.includes('--version')) {
      process.stdout.write(`${await pleachVersion()}\n`);
      return 0;
    }

    const { positionals, flags } = parseFlags(argv);
    const [verb, planPath] = positionals;

    if (verb === undefined) {
      process.stdout.write(HELP);
      return 2;
    }
    if (verb === 'schema') return verbSchema();
    if (verb === 'clean') return await verbClean(flags);

    if (verb === 'receipt') {
      if (planPath === undefined) throw new UsageError('receipt: <node> is required');
      return await verbReceipt(planPath, flags);
    }

    if (planPath === undefined) throw new UsageError(`${verb}: <plan.json> is required`);

    switch (verb) {
      case 'run':
        return await verbRun(planPath, flags);
      case 'land':
        return await verbLand(planPath, flags);
      case 'stop':
        return await verbStop(planPath, flags);
      case 'validate':
        return await verbValidate(planPath);
      default:
        throw new UsageError(`unknown verb '${verb}'`);
    }
  } catch (err) {
    if (
      err instanceof UsageError ||
      err instanceof PlanInvalidError ||
      err instanceof ConfigError
    ) {
      const detail = err instanceof PlanInvalidError ? err.reasons.join('\n  ') : err.message;
      process.stderr.write(`pleach: ${detail}\n`);
      return 2;
    }
    if (err instanceof LockHeldError || err instanceof NoRunError) {
      process.stderr.write(`pleach: ${err.message}\n`);
      return 3;
    }
    if (
      err instanceof RebuildRequiredError ||
      err instanceof TendTransportError ||
      err instanceof LandBlockedError ||
      err instanceof LandConflictError
    ) {
      process.stderr.write(`pleach: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`pleach: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
