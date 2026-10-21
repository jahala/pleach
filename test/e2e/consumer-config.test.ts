/**
 * E2E: the documented pleach.config.ts resolves in a consumer repo (jahala/pleach#147).
 *
 * docs/adapters.md shows a pleach.config.ts importing `pleach/adapters/umbel`,
 * `pleach/adapters/git` and `pleach/config`. The README runs pleach with
 * `bunx github:jahala/pleach`, which lands in bun's cache — not the repo's
 * node_modules — so in a repo that does not depend on pleach those imports
 * answer `Cannot find module`. The fix documents `bun add -d github:jahala/pleach`.
 *
 * This test builds a scratch git repo with NO pleach files, installs pleach as
 * a dev dependency from this checkout (`bun add -d file:<checkout>`, the offline
 * stand-in for the documented `bun add -d github:jahala/pleach`), drops in the
 * config taken VERBATIM from docs/adapters.md, and proves a one-node {command}
 * plan runs through it. A command node never spawns a worker (src/loop/run-node.ts
 * gives it a null worker), so the config's umbelRunner is constructed but never
 * drives umbel — the test runs with no network and no umbel binary.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRepo, execLocal } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const CHECKOUT = resolve(import.meta.dir, '../..');
const ADAPTERS_DOC = join(CHECKOUT, 'docs/adapters.md');

// The example config, extracted from docs/adapters.md by its heading so the doc
// and this test cannot drift. We do not hand-copy it: the same fenced block the
// doc shows is what the test writes and runs.
async function extractMinimalConfig(): Promise<string> {
  const doc = await readFile(ADAPTERS_DOC, 'utf8');
  const marker = 'A minimal `pleach.config.ts`';
  const start = doc.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const fenceOpen = doc.indexOf('```ts', start);
  expect(fenceOpen).toBeGreaterThanOrEqual(0);
  const codeStart = fenceOpen + '```ts'.length;
  const fenceClose = doc.indexOf('```', codeStart);
  expect(fenceClose).toBeGreaterThanOrEqual(0);
  return `${doc.slice(codeStart, fenceClose).trim()}\n`;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function pleach(args: string[], cwd?: string): Promise<RunResult> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
    ...(cwd !== undefined ? { cwd } : {}),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, stdout, stderr };
}

describe('consumer repo — documented pleach.config.ts resolves (#147)', () => {
  let repo = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanup = r.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  test('the documented config resolves after the documented install step', async () => {
    // The documented install step, run offline against this checkout.
    const add = await execLocal(['bun', 'add', '-d', `file:${CHECKOUT}`], repo);
    expect(add.exitCode).toBe(0);

    // The example config, taken verbatim from docs/adapters.md.
    await writeFile(join(repo, 'pleach.config.ts'), await extractMinimalConfig());

    // A one-node {command} plan: the command never spawns a worker, so the
    // config's umbelRunner is constructed but never used — no umbel needed.
    await writeFile(
      join(repo, 'plan.json'),
      JSON.stringify({
        goal: 'consumer config resolves',
        source: 'consumer-config',
        nodes: [{ id: 'c1', work: { command: 'true' } }],
      }),
    );

    const r = await pleach(['run', 'plan.json', '--repo-root', repo], repo);

    expect(r.stderr).not.toContain('Cannot find module');
    expect(r.code).toBe(0);
    const summary = JSON.parse(r.stdout.trim()) as { closed?: string[]; failed?: string[] };
    expect(summary.closed).toEqual(['c1']);
    expect(summary.failed).toEqual([]);
  }, 60_000);
});
