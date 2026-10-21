import { CastEnvError } from './errors.ts';

// Named casts (issue #146): a plan names a cast in `worker.provider` (or an
// auditor in `accept.audit.provider`); the config's cast resolves that name to
// the provider/model/env this environment reaches it by. The plan schema is
// unchanged — `provider` is already a free string. The face layer wraps the
// configured runner with `resolveCastSpawn`; this module is the pure half.

export type CastEnvValue = string | { fromEnv: string };

export interface Cast {
  provider: string;
  model?: string;
  env?: Record<string, CastEnvValue>;
}

// The runner port's spawn spec, narrowed to what cast resolution reads/writes.
export interface SpawnSpec {
  provider?: string;
  model?: string;
  cwd: string;
  env?: Record<string, string>;
}

// Reads an environment variable's value, or undefined when it is unset. Injected
// so the resolution stays pure (no process.env read here); the face passes the
// real process env.
export type ReadEnv = (name: string) => string | undefined;

// Resolve a spawn spec through the config's casts. A spec whose provider names
// a cast is rewritten to the cast's provider, with the plan's model winning over
// the cast's and the cast's env resolved at spawn. A spec that names no cast (or
// no provider at all) passes through unchanged. Each `{ fromEnv }` value is read
// now; a missing variable throws CastEnvError naming the cast and the variable,
// never an empty value.
export function resolveCastSpawn(
  spec: SpawnSpec,
  casts: Record<string, Cast>,
  readEnv: ReadEnv,
): SpawnSpec {
  const name = spec.provider;
  if (name === undefined) return spec;
  const cast = casts[name];
  if (cast === undefined) return spec;

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(cast.env ?? {})) {
    if (typeof value === 'string') {
      env[key] = value;
    } else {
      const fromEnv = readEnv(value.fromEnv);
      if (fromEnv === undefined) throw new CastEnvError(name, value.fromEnv);
      env[key] = fromEnv;
    }
  }

  const model = spec.model ?? cast.model;
  return {
    provider: cast.provider,
    ...(model !== undefined ? { model } : {}),
    cwd: spec.cwd,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

// The first variable a cast the plan names needs but the environment lacks, or
// null. The run face asks before it takes the lock, so a missing key refuses
// the run instead of failing a node at spawn after its setup (D36, fail before
// spend as in D19).
export function missingCastVariable(
  providerNames: readonly string[],
  casts: Record<string, Cast>,
  readEnv: ReadEnv,
): { cast: string; variable: string } | null {
  for (const name of providerNames) {
    for (const value of Object.values(casts[name]?.env ?? {})) {
      if (typeof value !== 'string' && readEnv(value.fromEnv) === undefined) {
        return { cast: name, variable: value.fromEnv };
      }
    }
  }
  return null;
}
