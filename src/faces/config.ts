import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { directCliRunner } from '../adapters/direct-cli.ts';
import { gitLedger } from '../adapters/git.ts';
import { tendLedger } from '../adapters/tend.ts';
import { umbelRunner } from '../adapters/umbel.ts';
import type { Cast, CastEnvValue } from '../core/cast.ts';
import { resolveCastSpawn } from '../core/cast.ts';
import { ConfigError } from '../core/errors.ts';
import type { ConductorDeps, LedgerSeam, RunnerSeam } from '../loop/deps.ts';
import { exec } from '../seams/exec.ts';
import { resolveGitDir } from '../seams/gitdir.ts';
import { createIsolateSeam } from '../seams/isolate.ts';
import { createJournal } from '../seams/journal.ts';
import { createLockSeam } from '../seams/lock.ts';
import { createReceiptStore } from '../seams/receipts.ts';

export type { Cast, CastEnvValue };

// ── Public types ──────────────────────────────────────────────────────────────

export interface PleachConfig {
  runner: RunnerSeam;
  ledger: LedgerSeam | Promise<LedgerSeam>;
  // Named casts (issue #146): a plan names one in `worker.provider` (or an
  // auditor in `accept.audit.provider`); the cast resolves it to the provider,
  // model and env this environment reaches it by — two casts can reach two
  // endpoints of one provider.
  casts?: Record<string, Cast>;
}

export interface ResolveSeamsOpts {
  config?: string;
  repoRoot: string;
  umbelBin: string;
  permissionMode?: string;
  allowedTools?: string;
  tendModule?: string;
  // Which bundled runner the default wiring uses (--runner). A config file
  // brings its own runner, so combining the two is a contradiction → ConfigError.
  runnerKind?: 'umbel' | 'direct-cli';
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function loadConfig(path: string, required: boolean): Promise<PleachConfig | null> {
  // Check file existence first.
  try {
    await access(path);
  } catch {
    if (required) throw new ConfigError(path, 'file not found');
    return null;
  }

  // Dynamic import — wrap all failures in ConfigError.
  let mod: unknown;
  try {
    mod = await import(path);
  } catch (err) {
    throw new ConfigError(
      path,
      `import failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Accept mod.default (ESM) or mod itself (CJS).
  const raw =
    typeof mod === 'object' && mod !== null && 'default' in mod
      ? (mod as { default: unknown }).default
      : mod;

  // Validate shape: must have runner and ledger as objects.
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof (raw as Record<string, unknown>).runner !== 'object' ||
    (raw as Record<string, unknown>).runner === null ||
    typeof (raw as Record<string, unknown>).ledger !== 'object' ||
    (raw as Record<string, unknown>).ledger === null
  ) {
    throw new ConfigError(path, 'export must be an object with runner and ledger fields');
  }

  const r = (raw as Record<string, unknown>).runner as Record<string, unknown>;
  const l = (raw as Record<string, unknown>).ledger as Record<string, unknown>;

  if (typeof r.spawnWorker !== 'function') {
    throw new ConfigError(path, 'runner must implement spawnWorker(spec)');
  }
  if (typeof l.readClosed !== 'function') {
    throw new ConfigError(path, 'ledger must implement readClosed(source)');
  }
  if (typeof l.emitVerdict !== 'function') {
    throw new ConfigError(path, 'ledger must implement emitVerdict(verdict, source)');
  }

  return raw as PleachConfig;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ResolveSeamsResult {
  runner: RunnerSeam;
  ledger: LedgerSeam;
  // The provider names the validate/run faces accept: the runner's own plus the
  // config's cast names. Absent → the runner accepts any provider name.
  providers?: readonly string[];
}

// Wrap a runner with the config's casts (issue #146): a spawn whose provider
// names a cast is rewritten to the cast's provider/model/env. Each `{ fromEnv }`
// value is read from the process env at spawn.
function wrapCasts(runner: RunnerSeam, casts: Record<string, Cast>): RunnerSeam {
  if (Object.keys(casts).length === 0) return runner;
  const readEnv = (name: string): string | undefined => process.env[name];
  return {
    ...(runner.providers !== undefined ? { providers: runner.providers } : {}),
    spawnWorker: (spec) => runner.spawnWorker(resolveCastSpawn(spec, casts, readEnv)),
  };
}

function combinedProviders(
  runnerProviders: readonly string[] | undefined,
  castNames: readonly string[],
): readonly string[] | undefined {
  const set = new Set([...(runnerProviders ?? []), ...castNames]);
  return set.size === 0 ? undefined : [...set];
}

export async function resolveSeams(opts: ResolveSeamsOpts): Promise<ResolveSeamsResult> {
  const explicit = opts.config !== undefined;
  // A relative --config is resolved against the working directory once here, so
  // the dynamic import below never sees a relative specifier. A relative
  // specifier would resolve from THIS module (src/faces/), not from where the
  // user typed the command (jahala/pleach#148).
  const configPath =
    opts.config !== undefined ? resolve(opts.config) : join(opts.repoRoot, 'pleach.config.ts');

  const config = await loadConfig(configPath, explicit);

  if (config !== null) {
    if (opts.runnerKind !== undefined) {
      throw new ConfigError(
        configPath,
        '--runner conflicts with a config file (the config brings its own runner) — drop one',
      );
    }
    const casts = config.casts ?? {};
    return {
      runner: wrapCasts(config.runner, casts),
      ledger: await config.ledger,
      providers: combinedProviders(config.runner.providers, Object.keys(casts)),
    };
  }

  // Default wiring: the selected bundled runner + git or tend ledger.
  const runner =
    opts.runnerKind === 'direct-cli'
      ? directCliRunner()
      : umbelRunner({
          bin: opts.umbelBin,
          ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
          ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
        });

  const ledger =
    opts.tendModule !== undefined
      ? await tendLedger({ module: opts.tendModule })
      : gitLedger({ repo: opts.repoRoot });

  return { runner, ledger, providers: runner.providers };
}

// ── buildDeps ───────────────────────────────────────────────────────────────

export interface BuildDepsOpts {
  repoRoot: string;
  runner: RunnerSeam;
  ledger: LedgerSeam;
  // Run journal path; defaults to <git-dir>/pleach/journal.jsonl (the git dir
  // is resolved through seams/gitdir.ts, so linked worktrees work).
  journal?: string;
  // Optional per-event observer (the narration floor): called with each event
  // after its durable journal append. The CLI passes a stderr renderer; a
  // library caller can pass anything (or nothing).
  narrate?: (event: Record<string, unknown>) => void;
}

// Assemble a ConductorDeps for runPlan from the four pleach-owned seams
// (exec/isolate/lock/journal) plus the two adapters you bring. The library
// counterpart to the CLI's wiring: supply a runner + ledger (from resolveSeams,
// or any RunnerSeam/LedgerSeam) and hand the result to runPlan.
// The receipt verb's slim composition — no runner or ledger needed to verify
// a settled node's receipt against the local repo.
export function receiptDeps(repoRoot: string): Pick<ConductorDeps, 'receipts' | 'isolate'> {
  return {
    isolate: createIsolateSeam(exec, repoRoot),
    receipts: createReceiptStore(join(resolveGitDir(repoRoot), 'pleach', 'receipts')),
  };
}

export function buildDeps(opts: BuildDepsOpts): ConductorDeps {
  const pleachDir = join(resolveGitDir(opts.repoRoot), 'pleach');
  const journalPath = opts.journal ?? join(pleachDir, 'journal.jsonl');
  return {
    exec,
    isolate: createIsolateSeam(exec, opts.repoRoot),
    lock: createLockSeam(),
    journal: createJournal(journalPath, opts.narrate),
    runner: opts.runner,
    ledger: opts.ledger,
    receipts: createReceiptStore(join(pleachDir, 'receipts')),
  };
}
