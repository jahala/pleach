/**
 * E2E: `pleach run --runner direct-cli` — the headless-CLI profile through the
 * real CLI + real git, with FAKE `claude` and `codex` binaries on PATH (the
 * fake-binary pattern from ENGINEERING's testing doctrine — no subscription,
 * runs in CI). Proves the bundled adapter drives the full ladder: spawn →
 * build → smoke → cross-provider audit → verified close → node branch.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepo, gitIn } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

// Fake `claude`: writes a file into the worktree (its cwd) and prints a message.
const FAKE_CLAUDE = `#!/bin/sh
echo "built" > built.txt
echo "fake claude: done"
`;

// Fake `codex`: prints a passing audit fence — the egress pleach parses.
// \140 is the backtick (printf octal escape) — keeps the shell script free of
// backtick/backslash quoting traps inside this template literal.
const FAKE_CODEX = `#!/bin/sh
echo "ran the audit command."
printf '\\140\\140\\140tend-audit-result\\n'
printf '{"verdicts":[{"check":"c1","verdict":"pass","reasons":[]}],"drift":[]}\\n'
printf '\\140\\140\\140\\n'
`;

const PLAN = {
  goal: 'one build node with a cross-provider audit, headless',
  source: 'e2e-direct-cli',
  nodes: [
    {
      id: 'feature',
      work: { prompt: 'build the feature' },
      accept: {
        smoke: 'test -f built.txt',
        audit: { command: 'true', provider: 'codex' },
      },
    },
  ],
};

describe('direct-cli runner — e2e with fake headless binaries', () => {
  let repo = '';
  let cleanupRepo: () => Promise<void> = () => Promise.resolve();
  let binDir = '';

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanupRepo = r.cleanup;
    binDir = await mkdtemp(join(tmpdir(), 'pleach-fakebin-'));
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, 'claude'), FAKE_CLAUDE);
    await writeFile(join(binDir, 'codex'), FAKE_CODEX);
    await chmod(join(binDir, 'claude'), 0o755);
    await chmod(join(binDir, 'codex'), 0o755);
  });

  afterEach(async () => {
    await cleanupRepo();
    await rm(binDir, { recursive: true, force: true });
  });

  test('run --runner direct-cli reaches a verified close with no umbel', async () => {
    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(PLAN));

    const proc = Bun.spawn(
      ['bun', MAIN, 'run', planPath, '--repo-root', repo, '--runner', 'direct-cli'],
      {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: repo,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const summary = JSON.parse(stdout.trim()) as { closed: string[]; failed: string[] };
    expect(summary.failed).toEqual([]);
    expect(summary.closed).toEqual(['feature']);
    expect(code).toBe(0);
    expect(stderr).not.toContain('umbel');

    expect(await gitIn(repo, 'show', 'node/feature:built.txt')).toBe('built');
  }, 60_000);

  test('--runner rejects unknown values with a usage error', async () => {
    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(PLAN));

    const proc = Bun.spawn(['bun', MAIN, 'run', planPath, '--runner', 'warp-drive'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: repo,
      env: process.env,
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    expect(code).toBe(2);
    expect(stderr).toContain('warp-drive');
  });

  test('--runner conflicts with --config — explicit contradiction, usage error', async () => {
    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(PLAN));
    const configPath = join(import.meta.dir, '../fixtures/pleach.config.custom.ts');

    const proc = Bun.spawn(
      ['bun', MAIN, 'run', planPath, '--config', configPath, '--runner', 'direct-cli'],
      {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: repo,
        env: process.env,
      },
    );
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    expect(code).toBe(2);
    expect(stderr).toContain('--runner');
  });
});
