/**
 * Integration: CI sees the runner and the canary tells the truth (ledger D25).
 *
 * The suites that drive the real umbel binary skip without it, and the check
 * job has none, so a move in umbel's contract went unseen until a person ran
 * them by hand. CI's `runner` job builds umbel at a pinned commit and runs
 * them; the weekly `umbel-head` job runs them against umbel's default branch.
 * Every such suite must be in both, or a new one would skip in CI forever.
 *
 * The canary skipped (exit 0) when no tend2 CLI resolved, so every GitHub run
 * reported green having checked nothing. On CI it now fails instead.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '../..');

interface Step {
  run?: string;
  env?: Record<string, string>;
}
interface Workflow {
  jobs: Record<string, { env?: Record<string, string>; steps: Step[] }>;
}

function workflow(name: string): Workflow {
  return Bun.YAML.parse(readFileSync(join(ROOT, '.github/workflows', name), 'utf8')) as Workflow;
}

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return path.endsWith('.test.ts') ? [path] : [];
  });
}

// The suites that need umbel and nothing else: they read PLEACH_UMBEL_BIN
// (or fall back to umbel on PATH) and not the tend module.
function runnerSuites(): string[] {
  return testFiles(join(ROOT, 'test'))
    .filter((file) => {
      const text = readFileSync(file, 'utf8');
      return text.includes('PLEACH_UMBEL_BIN') && !text.includes('PLEACH_TEND_MODULE');
    })
    .map((file) => relative(ROOT, file))
    .sort();
}

// What a job's steps run with PLEACH_UMBEL_BIN set.
function suitesRunBy(job: Workflow['jobs'][string]): string[] {
  return job.steps
    .filter((step) => step.env?.PLEACH_UMBEL_BIN !== undefined && step.run !== undefined)
    .flatMap((step) => (step.run ?? '').split(/\s+/).filter((word) => word.endsWith('.test.ts')))
    .sort();
}

describe('CI runs the runner suites (D25)', () => {
  test('the suites are found, not vacuously empty', () => {
    expect(runnerSuites()).toContain('test/integration/umbel-seam.test.ts');
  });

  // ledger: D25 — every umbel suite runs in CI against a pinned umbel.
  test("ci.yml's runner job runs every umbel suite against a pinned umbel commit", () => {
    const job = workflow('ci.yml').jobs.runner;
    expect(job).toBeDefined();
    expect(job.env?.UMBEL_REF).toMatch(/^[0-9a-f]{40}$/);
    expect(suitesRunBy(job)).toEqual(runnerSuites());
  });

  // ledger: D25 — and weekly against umbel's default branch.
  test("canary.yml's umbel-head job runs every umbel suite against umbel's default branch", () => {
    const job = workflow('canary.yml').jobs['umbel-head'];
    expect(job).toBeDefined();
    expect(suitesRunBy(job)).toEqual(runnerSuites());
  });
});

describe('the canary tells the truth (D25)', () => {
  function canary(env: Record<string, string>): { code: number; stderr: string } {
    const r = Bun.spawnSync(['bash', join(ROOT, 'scripts/canary.sh')], {
      cwd: ROOT,
      env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { code: r.exitCode ?? 1, stderr: r.stderr.toString() };
  }

  // ledger: D25 — on CI, a canary that cannot run is red.
  test('on CI with no tend2 CLI the canary fails', () => {
    const r = canary({ CI: 'true' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no tend2 CLI');
  });

  test('locally with no tend2 CLI the canary skips', () => {
    const r = canary({});
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('SKIP');
  });
});
