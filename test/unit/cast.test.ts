import { describe, expect, test } from 'bun:test';
import type { Cast } from '../../src/core/cast.ts';
import { resolveCastSpawn } from '../../src/core/cast.ts';
import { CastEnvError } from '../../src/core/errors.ts';

// Subject: resolveCastSpawn — the pure half of the face-layer cast wrapper
// (issue #146). A spec whose provider names a cast is rewritten to the cast's
// provider, the plan's model wins over the cast's, and each `{ fromEnv }` value
// is read at spawn from the injected reader. A missing variable is CastEnvError
// naming the cast and the variable — never an empty value.

const CASTS: Record<string, Cast> = {
  deepseek: {
    provider: 'claude',
    model: 'deepseek-chat',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: { fromEnv: 'DEEPSEEK_API_KEY' },
      ANTHROPIC_MODEL: 'deepseek-chat',
    },
  },
  opus: { provider: 'claude', model: 'claude-opus-4-5' },
};

const env = (name: string): string | undefined =>
  name === 'DEEPSEEK_API_KEY' ? 'sk-test-secret' : undefined;

describe('resolveCastSpawn', () => {
  test('a cast resolves provider, model and env', () => {
    const spec = resolveCastSpawn({ provider: 'deepseek', cwd: '/w' }, CASTS, env);
    expect(spec.provider).toBe('claude');
    expect(spec.model).toBe('deepseek-chat');
    expect(spec.cwd).toBe('/w');
    expect(spec.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-test-secret',
      ANTHROPIC_MODEL: 'deepseek-chat',
    });
  });

  test('the plan model wins over the cast model', () => {
    const spec = resolveCastSpawn(
      { provider: 'deepseek', model: 'deepseek-reasoner', cwd: '/w' },
      CASTS,
      env,
    );
    expect(spec.model).toBe('deepseek-reasoner');
  });

  test('a cast with no env passes no env key', () => {
    const spec = resolveCastSpawn({ provider: 'opus', cwd: '/w' }, CASTS, env);
    expect(spec.provider).toBe('claude');
    expect(spec.model).toBe('claude-opus-4-5');
    expect('env' in spec).toBe(false);
  });

  test('a provider that names no cast passes through unchanged', () => {
    const spec = { provider: 'codex', cwd: '/w' };
    expect(resolveCastSpawn(spec, CASTS, env)).toBe(spec);
  });

  test('an absent provider passes through unchanged', () => {
    const spec = { cwd: '/w' };
    expect(resolveCastSpawn(spec, CASTS, env)).toBe(spec);
  });

  test('a missing { fromEnv } variable is CastEnvError naming the cast and the variable', () => {
    expect(() =>
      resolveCastSpawn({ provider: 'deepseek', cwd: '/w' }, CASTS, () => undefined),
    ).toThrow(CastEnvError);
    try {
      resolveCastSpawn({ provider: 'deepseek', cwd: '/w' }, CASTS, () => undefined);
    } catch (e) {
      const err = e as CastEnvError;
      expect(err.cast).toBe('deepseek');
      expect(err.variable).toBe('DEEPSEEK_API_KEY');
      expect(err.message).toContain('deepseek');
      expect(err.message).toContain('DEEPSEEK_API_KEY');
    }
  });
});
