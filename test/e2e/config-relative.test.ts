/**
 * E2E: a relative `--config` path is resolved from the working directory,
 * not from pleach's own source folder (jahala/pleach#148).
 *
 * `resolveSeams` hands the flag's value straight to `await import(path)`. A
 * dynamic import resolves a relative specifier from the importing module, so
 * `.context/pleach/pleach.config.ts` was looked up in `src/faces/`, not in the
 * directory where the user typed the command. This runs the real CLI from a
 * temp repo with a relative config path and expects a clean verified close.
 */
import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRepo } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const SRC = join(import.meta.dir, '../../src');

// A real config (scripted runner + git ledger), written into the temp repo.
// The absolute import specifiers point at pleach's own adapters, so the file
// loads from anywhere — the point under test is only the --config path.
const CONFIG_BODY = `import { gitLedger } from '${SRC}/adapters/git.ts';
import { scriptedRunner } from '${SRC}/adapters/scripted.ts';

export default {
  runner: scriptedRunner([]),
  ledger: gitLedger(),
};
`;

// ledger: D30 — a relative --config is read from the working directory.
test('pleach run with a relative --config path, run from the repo, closes the node', async () => {
  const { path: repo, cleanup } = await createRepo();
  try {
    const configDir = join(repo, '.context', 'pleach');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'pleach.config.ts'), CONFIG_BODY);

    const planPath = join(repo, 'plan.json');
    await writeFile(
      planPath,
      JSON.stringify({
        goal: 'a relative config path is resolved from cwd',
        source: 'e2e-config-relative',
        nodes: [
          {
            id: 'cfg',
            work: { command: 'bash -lc "echo ok > cfg.txt"' },
            policy: { maxAttempts: 1 },
          },
        ],
      }),
    );

    const proc = Bun.spawn(
      ['bun', MAIN, 'run', planPath, '--config', '.context/pleach/pleach.config.ts'],
      { cwd: repo, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(stderr).not.toContain('Cannot find module');
    expect(code).toBe(0);
    const summary = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as { closed?: string[] };
    expect(summary.closed).toEqual(['cfg']);
  } finally {
    await cleanup();
  }
}, 60_000);
