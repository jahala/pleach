import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ConfigError,
  LockHeldError,
  PlanInvalidError,
  RebuildRequiredError,
  TendTransportError,
} from '../core/errors.ts';
import { PlanSchema } from '../core/plan.ts';
import { planJsonSchema } from '../core/schema-json.ts';
import { validatePlan } from '../core/validate.ts';
import type { ConductorDeps, RunSummary } from '../loop/deps.ts';
import { runPlan } from '../loop/run-plan.ts';
import { exec } from '../seams/exec.ts';
import { createIsolateSeam } from '../seams/isolate.ts';
import { createJournal } from '../seams/journal.ts';
import { createLockSeam } from '../seams/lock.ts';
import { resolveSeams } from './config.ts';

const HELP = `pleach — deterministic conductor for DAGs of verified agent work

Usage:
  pleach run <plan.json> [flags]     Execute a plan
  pleach validate <plan.json>        Parse + validate a plan; print the topo order
  pleach schema                      Emit the plan contract as JSON Schema (for planners / codegen)
  pleach --help

Flags (run):
  --repo-root PATH        Git repo the worktrees and node/<id> branches live in (default: cwd)
  --max-concurrency N     Parallel node cap (default: 1)
  --timeout-ms N          Default per-attempt timeout when a node omits policy.timeoutMs (default: 30m)
  --journal PATH          Run journal JSONL (default: <repo-root>/.git/pleach/journal.jsonl)
  --rctrl-bin PATH        rctrl binary (default: $PLEACH_RCTRL_BIN or 'rctrl' on PATH)
  --config PATH           pleach.config.ts selecting the runner + ledger
                          (default: <repo-root>/pleach.config.ts if present)
  --tend-module PATH      use the tend ledger via this ingester module ($PLEACH_TEND_MODULE);
                          omit it (with no config) to run standalone on the git ledger (node/<id> branches)
  --allowed-tools LIST    Tool allowlist for claude workers (cannot cover MCP tools)
  --permission-mode MODE  Permission/approval mode for workers (default: bypassPermissions —
                          unattended workers can't answer prompts; safety is external). Rides
                          claude (any mode) and codex (bypassPermissions only).

Landing is manual by design: verified work is published as node/<id> branches;
merge the integration node's branch yourself (git merge node/<feature>).

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
  rctrlBin: string;
  tendModule?: string;
  allowedTools?: string;
  permissionMode: string;
  config?: string;
}

class UsageError extends Error {
  readonly name = 'UsageError';
}

function parseFlags(argv: readonly string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = {
    repoRoot: process.cwd(),
    rctrlBin: process.env.PLEACH_RCTRL_BIN ?? 'rctrl',
    // Workers run unattended — default to bypassing in-worker permission prompts
    // (a curated allowlist can't cover MCP tools). Safety is external: disposable
    // worktree + cross-provider audit + gates. Override with --permission-mode.
    permissionMode: 'bypassPermissions',
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
      case '--rctrl-bin':
        flags.rctrlBin = takeValue(arg, next);
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
  const { order } = validatePlan(plan);
  process.stdout.write(`${JSON.stringify({ valid: true, order })}\n`);
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

async function verbRun(planPath: string, flags: Flags): Promise<number> {
  const plan = await readPlan(planPath);

  const journalPath = flags.journal ?? join(flags.repoRoot, '.git', 'pleach', 'journal.jsonl');
  const { runner, ledger } = await resolveSeams({
    repoRoot: flags.repoRoot,
    rctrlBin: flags.rctrlBin,
    permissionMode: flags.permissionMode,
    ...(flags.config !== undefined ? { config: flags.config } : {}),
    ...(flags.allowedTools !== undefined ? { allowedTools: flags.allowedTools } : {}),
    ...(flags.tendModule !== undefined ? { tendModule: flags.tendModule } : {}),
  });
  const deps: ConductorDeps = {
    exec,
    isolate: createIsolateSeam(exec, flags.repoRoot),
    lock: createLockSeam(),
    journal: createJournal(journalPath),
    runner,
    ledger,
  };

  process.stderr.write(`pleach: running ${plan.nodes.length} nodes (journal: ${journalPath})\n`);
  const summary = await runPlan(plan, deps, {
    repoRoot: flags.repoRoot,
    ...(flags.maxConcurrency !== undefined ? { maxConcurrency: flags.maxConcurrency } : {}),
    ...(flags.timeoutMs !== undefined ? { defaultTimeoutMs: flags.timeoutMs } : {}),
  });

  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summaryExitCode(summary);
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
    if (err instanceof RebuildRequiredError || err instanceof TendTransportError) {
      process.stderr.write(`pleach: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`pleach: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
