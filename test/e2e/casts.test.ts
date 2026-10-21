/**
 * E2E: named casts in the config (issue #146).
 *
 * `pleach validate` resolves the config's casts + the runner's providers, so a
 * plan naming a cast is accepted and a typo is refused with the known names —
 * before any spawn. The config imports pleach's own adapters by absolute
 * specifier (the config-relative.test.ts pattern), so no `bun add` is needed
 * and no umbel binary or network is touched: validate never spawns a worker.
 */
import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRepo } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const SRC = join(import.meta.dir, '../../src');

const CONFIG_BODY = `import { umbelRunner } from '${SRC}/adapters/umbel.ts';
import { gitLedger } from '${SRC}/adapters/git.ts';

export default {
  runner: umbelRunner({ bin: 'umbel' }),
  ledger: gitLedger({ repo: '.' }),
  casts: {
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
  },
};
`;

function planBody(provider: string): string {
  return JSON.stringify({
    goal: 'named casts',
    source: 'e2e-casts',
    nodes: [{ id: 'n1', worker: { provider }, work: { prompt: 'build it' } }],
  });
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function validate(repo: string, provider: string): Promise<RunResult> {
  await writeFile(join(repo, 'plan.json'), planBody(provider));
  const proc = Bun.spawn(['bun', MAIN, 'validate', 'plan.json', '--config', 'pleach.config.ts'], {
    cwd: repo,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, stdout, stderr };
}

test('pleach validate accepts a plan naming a declared cast and refuses a typo', async () => {
  const { path: repo, cleanup } = await createRepo();
  try {
    await writeFile(join(repo, 'pleach.config.ts'), CONFIG_BODY);

    const good = await validate(repo, 'deepseek');
    expect(good.stderr).not.toContain('Cannot find module');
    expect(good.code).toBe(0);
    expect(JSON.parse(good.stdout.trim()).valid).toBe(true);

    const bad = await validate(repo, 'cluade');
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('cluade');
    expect(bad.stderr).toContain('deepseek');
    expect(bad.stderr).toContain('claude');
  } finally {
    await cleanup();
  }
}, 60_000);
