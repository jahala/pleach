import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { gitLedger } from '../adapters/git.ts';
import { rctrlRunner } from '../adapters/rctrl.ts';
import { tendLedger } from '../adapters/tend.ts';
import { ConfigError } from '../core/errors.ts';
import type { LedgerSeam, RunnerSeam } from '../loop/deps.ts';

// ── Public types ──────────────────────────────────────────────────────────────

export interface PleachConfig {
  runner: RunnerSeam;
  ledger: LedgerSeam | Promise<LedgerSeam>;
}

export interface ResolveSeamsOpts {
  config?: string;
  repoRoot: string;
  rctrlBin: string;
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

  // Default wiring: rctrl runner + git or tend ledger.
  const runner = rctrlRunner({
    bin: opts.rctrlBin,
    permissionMode: opts.permissionMode,
    ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
  });

  const ledger =
    opts.tendModule !== undefined
      ? await tendLedger({ module: opts.tendModule })
      : gitLedger({ repo: opts.repoRoot });

  return { runner, ledger };
}
