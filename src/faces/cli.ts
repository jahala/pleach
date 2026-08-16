import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import {
  ConfigError,
  LandBlockedError,
  LandConflictError,
  LockHeldError,
  PlanInvalidError,
  RebuildRequiredError,
  TendTransportError,
} from '../core/errors.ts';
import { PlanSchema } from '../core/plan.ts';
import { planJsonSchema } from '../core/schema-json.ts';
import { nodeSummaries, validatePlan } from '../core/validate.ts';
import type { RunSummary } from '../loop/deps.ts';
import { landPlan } from '../loop/land.ts';
import { runPlan } from '../loop/run-plan.ts';
import { buildDeps, resolveSeams } from './config.ts';

const HELP = `pleach — deterministic conductor for DAGs of verified agent work

Usage:
  pleach run <plan.json> [flags]     Execute a plan
  pleach land <plan.json> [flags]    Merge a verified plan's sinks onto the checked-out branch
  pleach validate <plan.json>        Parse + validate a plan; print the topo order
  pleach schema                      Emit the plan contract as JSON Schema (for planners / codegen)
  pleach --help

Flags (run):
  --repo-root PATH        Git repo the worktrees and node/<id> branches live in (default: cwd)
  --max-concurrency N     Parallel node cap (default: plan.maxConcurrency, else CPU cores − 2)
  --timeout-ms N          Default per-attempt timeout when a node omits policy.timeoutMs (default: 30m)
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
  --permission-mode MODE  Permission/approval mode for workers (default: bypassPermissions —
                          unattended workers can't answer prompts; safety is external). Rides
                          claude (any mode) and codex (bypassPermissions only).
  --land                  After a fully-verified close, land the plan (see below); the run
                          summary gains a "land" object. A red run never lands.

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
  3  another conductor holds the lock for this (repo, source)
`;

interface Flags {
  repoRoot: string;
  maxConcurrency?: number;
  timeoutMs?: number;
  journal?: string;
  umbelBin: string;
  tendModule?: string;
  allowedTools?: string;
  permissionMode: string;
  config?: string;
  land: boolean;
  runnerKind?: 'umbel' | 'direct-cli';
}

class UsageError extends Error {
  readonly name = 'UsageError';
}

function parseFlags(argv: readonly string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = {
    repoRoot: process.cwd(),
    umbelBin: process.env.PLEACH_UMBEL_BIN ?? 'umbel',
    // Workers run unattended — default to bypassing in-worker permission prompts
    // (a curated allowlist can't cover MCP tools). Safety is external: disposable
    // worktree + cross-provider audit + gates. Override with --permission-mode.
    permissionMode: 'bypassPermissions',
    land: false,
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

async function verbValidate(planPath: string): Promise<number> {
  const plan = await readPlan(planPath);
  const { order, waves } = validatePlan(plan);
  process.stdout.write(
    `${JSON.stringify({ valid: true, order, waves, nodes: nodeSummaries(plan) })}\n`,
  );
  return 0;
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
    summary.skipped.length === 0;
  return clean ? 0 : 1;
}

async function depsFromFlags(flags: Flags) {
  const { runner, ledger } = await resolveSeams({
    repoRoot: flags.repoRoot,
    umbelBin: flags.umbelBin,
    permissionMode: flags.permissionMode,
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
  });
}

async function verbRun(planPath: string, flags: Flags): Promise<number> {
  const plan = await readPlan(planPath);
  const deps = await depsFromFlags(flags);

  process.stderr.write(`pleach: running ${plan.nodes.length} nodes\n`);
  const summary = await runPlan(plan, deps, {
    repoRoot: flags.repoRoot,
    // The contract's conductor default when neither flag nor plan caps it:
    // cores−2, floored at 1 (the loop stays environment-free).
    defaultConcurrency: Math.max(1, cpus().length - 2),
    ...(flags.maxConcurrency !== undefined ? { maxConcurrency: flags.maxConcurrency } : {}),
    ...(flags.timeoutMs !== undefined ? { defaultTimeoutMs: flags.timeoutMs } : {}),
  });

  if (summary.alreadyVerified.length > 0) {
    process.stderr.write(
      `pleach: skipped ${summary.alreadyVerified.length} already-verified node(s)\n`,
    );
  }
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

async function verbLand(planPath: string, flags: Flags): Promise<number> {
  const plan = await readPlan(planPath);
  const deps = await depsFromFlags(flags);
  const land = await landPlan(plan, deps, { repoRoot: flags.repoRoot });
  process.stderr.write(`pleach: landed ${land.landed.join(', ')} on '${land.branch}'\n`);
  process.stdout.write(`${JSON.stringify(land)}\n`);
  return 0;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  try {
    const { positionals, flags } = parseFlags(argv);
    const [verb, planPath] = positionals;

    if (verb === undefined || argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(HELP);
      return verb === undefined && !argv.includes('--help') && !argv.includes('-h') ? 2 : 0;
    }
    if (verb === 'schema') return verbSchema();

    if (planPath === undefined) throw new UsageError(`${verb}: <plan.json> is required`);

    switch (verb) {
      case 'run':
        return await verbRun(planPath, flags);
      case 'land':
        return await verbLand(planPath, flags);
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
    if (err instanceof LockHeldError) {
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
