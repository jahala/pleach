import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { gitLedger } from '../adapters/git.ts';
import { tendLedger } from '../adapters/tend.ts';
import { umbelRunner } from '../adapters/umbel.ts';
import { ConfigError } from '../core/errors.ts';
import type { ConductorDeps, LedgerSeam, RunnerSeam } from '../loop/deps.ts';
import { exec } from '../seams/exec.ts';
import { createIsolateSeam } from '../seams/isolate.ts';
import { createJournal } from '../seams/journal.ts';
import { createLockSeam } from '../seams/lock.ts';

// ── Public types ──────────────────────────────────────────────────────────────

export interface PleachConfig {
  runner: RunnerSeam;
  ledger: LedgerSeam | Promise<LedgerSeam>;
}

export interface ResolveSeamsOpts {
  config?: string;
  repoRoot: string;
  umbelBin: string;
  permissionMode: string;
  allowedTools?: string;
  tendModule?: string;
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

export async function resolveSeams(
  opts: ResolveSeamsOpts,
): Promise<{ runner: RunnerSeam; ledger: LedgerSeam }> {
  const explicit = opts.config !== undefined;
  const configPath = opts.config ?? join(opts.repoRoot, 'pleach.config.ts');

  const config = await loadConfig(configPath, explicit);

  if (config !== null) {
    return { runner: config.runner, ledger: await config.ledger };
  }

  // Default wiring: umbel runner + git or tend ledger.
  const runner = umbelRunner({
    bin: opts.umbelBin,
    permissionMode: opts.permissionMode,
    ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
  });

  const ledger =
    opts.tendModule !== undefined
      ? await tendLedger({ module: opts.tendModule })
      : gitLedger({ repo: opts.repoRoot });

  return { runner, ledger };
}

// ── buildDeps ───────────────────────────────────────────────────────────────

export interface BuildDepsOpts {
  repoRoot: string;
  runner: RunnerSeam;
  ledger: LedgerSeam;
  // Run journal path; defaults to <repoRoot>/.git/pleach/journal.jsonl.
  journal?: string;
}

// Assemble a ConductorDeps for runPlan from the four pleach-owned seams
// (exec/isolate/lock/journal) plus the two adapters you bring. The library
// counterpart to the CLI's wiring: supply a runner + ledger (from resolveSeams,
// or any RunnerSeam/LedgerSeam) and hand the result to runPlan.
export function buildDeps(opts: BuildDepsOpts): ConductorDeps {
  const journalPath = opts.journal ?? join(opts.repoRoot, '.git', 'pleach', 'journal.jsonl');
  return {
    exec,
    isolate: createIsolateSeam(exec, opts.repoRoot),
    lock: createLockSeam(),
    journal: createJournal(journalPath),
    runner: opts.runner,
    ledger: opts.ledger,
  };
}
