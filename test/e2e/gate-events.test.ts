/**
 * E2E: a real run with a smoke that fails on attempt 1 and passes on attempt 2
 * leaves a journal a watcher can read mid-run — `attempt-start` per attempt and
 * `gate-start`/`gate-end` around the smoke, in order, and every line still
 * carries the garden's one envelope (issue #63, ledger D15).
 *
 * The real CLI as a process, real git, a real smoke script with a gate-only
 * retry red and a red that spends an attempt, and the bundled direct-cli runner
 * driving a fake `claude` binary (no subscription, runs in CI). The pinned
 * kinds and keys are restated here, not imported, for the same reason the
 * journal-envelope sibling restates them: a reader of this journal has the
 * profile, not pleach's table.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepo } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

const UNIVERSAL = ['time', 'event.name', 'plotplot.kind', 'plotplot.count'] as const;
const KINDS = new Set(['gate.retry', 'run.lifecycle', 'node.lifecycle', 'gate.result']);

const FAKE_CLAUDE = `#!/bin/sh
echo "built" > built.txt
echo "fake claude: done"
`;

async function journalLines(repo: string): Promise<Record<string, unknown>[]> {
  const raw = await Bun.file(join(repo, '.git', 'pleach', 'journal.jsonl')).text();
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('the run journal holds the gate events of a real run (issue #63)', () => {
  let repo = '';
  let cleanupRepo: () => Promise<void> = () => Promise.resolve();
  let binDir = '';

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanupRepo = r.cleanup;
    binDir = await mkdtemp(join(tmpdir(), 'pleach-gate-bin-'));
    await writeFile(join(binDir, 'claude'), FAKE_CLAUDE);
    await chmod(join(binDir, 'claude'), 0o755);
  });

  afterEach(async () => {
    await cleanupRepo();
    await rm(binDir, { recursive: true, force: true });
  });

  test('a smoke red on attempt 1 and green on attempt 2 journals the gates, all enveloped', async () => {
    const s1 = join(repo, 'smoke.s1');
    const s2 = join(repo, 'smoke.s2');
    const smoke = join(repo, 'smoke.sh');
    await writeFile(
      smoke,
      `#!/usr/bin/env bash\ntest -f built.txt || { echo "missing built.txt" >&2; exit 1; }\n` +
        `if [ ! -f "${s1}" ]; then touch "${s1}"; echo "transient red 1" >&2; exit 1; fi\n` +
        `if [ ! -f "${s2}" ]; then touch "${s2}"; echo "transient red 2" >&2; exit 1; fi\n` +
        `exit 0\n`,
    );
    await chmod(smoke, 0o755);

    const plan = {
      goal: 'a real run journals its gate events',
      source: 'e2e-gate-events',
      nodes: [
        {
          id: 'build',
          worker: { provider: 'claude', model: 'claude-opus-5' },
          work: { prompt: 'build the feature' },
          accept: { smoke: `bash ${smoke}` },
          policy: { maxAttempts: 2 },
        },
      ],
    };
    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(plan));

    const proc = Bun.spawn(
      ['bun', MAIN, 'run', '--no-redact', planPath, '--repo-root', repo, '--runner', 'direct-cli'],
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

    expect({ code, stderr }).toMatchObject({ code: 0 });
    const summary = JSON.parse(stdout.trim()) as { closed: string[]; failed: string[] };
    expect(summary.failed).toEqual([]);
    expect(summary.closed).toEqual(['build']);

    const lines = await journalLines(repo);

    // Every line is one enveloped JSON object.
    for (const line of lines) {
      expect(typeof line.event).toBe('string');
      expect(line['event.name']).toBe(`pleach.${line.event as string}`);
      for (const key of UNIVERSAL) expect(Object.hasOwn(line, key)).toBe(true);
      expect(KINDS.has(line['plotplot.kind'] as string)).toBe(true);
      expect(line['plotplot.count']).toBe(1);
    }

    // The gate events a watcher reads, in file order.
    const gate = lines.filter((l) =>
      ['attempt-start', 'gate-start', 'gate-end', 'verdict'].includes(l.event as string),
    );
    const attempt1 = gate.findIndex((l) => l.event === 'attempt-start' && l.attempt === 1);
    const attempt2 = gate.findIndex((l) => l.event === 'attempt-start' && l.attempt === 2);
    const smokeStart = gate.findIndex((l) => l.event === 'gate-start' && l.gate === 'smoke');
    const smokeEndRed = gate.findIndex(
      (l) => l.event === 'gate-end' && l.gate === 'smoke' && (l.exitCode as number) !== 0,
    );
    const smokeEndGreen = gate.findIndex(
      (l) => l.event === 'gate-end' && l.gate === 'smoke' && (l.exitCode as number) === 0,
    );
    const verdict = gate.findIndex((l) => l.event === 'verdict');

    expect(attempt1).toBe(0);
    expect(smokeStart).toBeGreaterThan(attempt1);
    expect(smokeEndRed).toBeGreaterThan(smokeStart);
    expect(attempt2).toBeGreaterThan(smokeEndRed);
    expect(smokeEndGreen).toBeGreaterThan(attempt2);
    expect(verdict).toBeGreaterThan(smokeEndGreen);

    const failing = gate[smokeEndRed] as Record<string, unknown>;
    expect(failing.attempt).toBe(1);
    expect(failing.exitCode).toBe(1);
    expect(String(failing.outputTail)).toContain('transient red 2');
    const passing = gate[smokeEndGreen] as Record<string, unknown>;
    expect(passing.attempt).toBe(2);
    expect(passing.exitCode).toBe(0);
    expect(Object.hasOwn(passing, 'outputTail')).toBe(false);
  }, 120_000);
});
