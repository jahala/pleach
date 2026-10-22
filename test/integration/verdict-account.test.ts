// Integration: a verdict that settled away from 'done' carries a non-empty
// reason and a non-empty nextStep on the journal line, proven against the real
// CLI (issue #106). Mirrors the umbrella's seam test
// (contracts/test/verdict.test.sh in jahala/plotplot): a one-node plan whose
// smoke gate fails in the ordinary way — `false` — is run through the real
// `bun src/main.ts run`, and the journal's verdict line for that node must
// carry both fields as non-empty strings. A `{command}` node needs no runner,
// so the real CLI runs against real git alone, no umbel, no tmux.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRepo } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

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

async function pleach(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: repo,
    env: process.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, stdout, stderr };
}

// ledger: #106
test('a node whose smoke gate is `false` settles failed with a non-empty reason and nextStep', async () => {
  const planPath = join(repo, 'plan.json');
  const journalPath = join(repo, 'journal.jsonl');
  await writeFile(
    planPath,
    JSON.stringify({
      goal: 'g',
      source: 'verdict-account',
      nodes: [
        {
          id: 'verdict.c1',
          work: { command: 'true' },
          accept: { smoke: 'false' },
          policy: { maxAttempts: 1 },
        },
      ],
    }),
  );

  const res = await pleach([
    'run',
    'plan.json',
    '--repo-root',
    repo,
    '--no-redact',
    '--journal',
    journalPath,
    '--max-concurrency',
    '1',
  ]);
  expect(res.code).toBe(1); // the node failed — the run is not clean

  const lines = (await readFile(journalPath, 'utf8'))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const verdict = lines.filter((e) => e.event === 'verdict' && e.node === 'verdict.c1').at(-1);
  expect(verdict?.status).toBe('failed');

  expect(typeof verdict?.reason).toBe('string');
  expect((verdict?.reason as string).length).toBeGreaterThan(0);
  expect(verdict?.reason as string).toContain('false');

  expect(typeof verdict?.nextStep).toBe('string');
  expect((verdict?.nextStep as string).length).toBeGreaterThan(0);
  expect(verdict?.nextStep as string).toContain('quarantine/verdict.c1');
}, 60_000);
