#!/usr/bin/env bun
/**
 * load-flake.ts — reproduce the issue #160 integration-test flakes under load.
 *
 * Runs `N` copies of `bun test` in parallel (the condition the batch-5 build
 * failures were seen under: several full suites on one machine at once),
 * repeated over rounds, and collects every failure with its test name, error
 * and output. It does not assert anything itself: it reports what failed and
 * exits non-zero when any worker failed, so a caller can script "zero failures
 * in R rounds of N" as the proof.
 *
 * Usage:
 *   bun scripts/load-flake.ts [--n 5] [--rounds 10] [--files <path>...]
 *
 * Default files are the two the issue names:
 *   test/integration/run-journal-copy.test.ts test/e2e/land.test.ts
 *
 * Each worker runs in its own process group so a hung `bun test` can be killed
 * without taking the harness down; a worker that exceeds --timeout is killed
 * and recorded as a timeout failure (a timeout catches a hang, never slowness).
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Args {
  n: number;
  rounds: number;
  files: string[];
  timeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  let n = 5;
  let rounds = 10;
  let timeoutMs = 0;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--n') n = Number(argv[++i]);
    else if (a === '--rounds') rounds = Number(argv[++i]);
    else if (a === '--timeout') timeoutMs = Number(argv[++i]);
    else if (a === '--files') {
      while (i + 1 < argv.length && !(argv[i + 1] as string).startsWith('--')) {
        files.push(argv[++i] as string);
      }
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'bun scripts/load-flake.ts [--n 5] [--rounds 10] [--timeout ms] [--files <paths...>]\n',
      );
      process.exit(0);
    }
  }
  return {
    n,
    rounds,
    files:
      files.length > 0
        ? files
        : ['test/integration/run-journal-copy.test.ts', 'test/e2e/land.test.ts'],
    timeoutMs,
  };
}

interface WorkerResult {
  round: number;
  index: number;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  failureSummary: string;
}

function summarize(output: string): string {
  // The lines that name a failing test and its error, kept for the report.
  const lines = output.split('\n');
  const markers = lines.filter(
    (l) => /(fail|✗|failed|Error:|ENOENT|timed out|timeout)/.test(l) && !/^\s*$/.test(l),
  );
  return markers.slice(0, 40).join('\n');
}

async function runWorker(
  round: number,
  index: number,
  files: string[],
  timeoutMs: number,
): Promise<WorkerResult> {
  const proc = Bun.spawn(['bun', 'test', ...files], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
    cwd: process.cwd(),
    detached: true,
  });

  const collect = async () => {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { output: out + err, exitCode };
  };

  let result: { output: string; exitCode: number | null };
  let timedOut = false;
  if (timeoutMs > 0) {
    const timeout = new Promise<{ output: string; exitCode: number | null }>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
        resolve({ output: '(worker timed out and was killed)\n', exitCode: null });
      }, timeoutMs),
    );
    result = await Promise.race([collect(), timeout]);
  } else {
    result = await collect();
  }

  return {
    round,
    index,
    exitCode: result.exitCode,
    timedOut,
    output: result.output,
    failureSummary: summarize(result.output),
  };
}

const { n, rounds, files, timeoutMs } = parseArgs(process.argv.slice(2));

const failures: WorkerResult[] = [];
const bySummary = new Map<string, number>();

process.stderr.write(`load-flake: ${rounds} rounds × ${n} workers over ${files.join(', ')}\n`);

for (let round = 1; round <= rounds; round++) {
  const started = Date.now();
  const workers = await Promise.all(
    Array.from({ length: n }, (_, i) => runWorker(round, i + 1, files, timeoutMs)),
  );
  const failed = workers.filter((w) => w.exitCode !== 0 || w.timedOut);
  failures.push(...failed);
  for (const f of failed) {
    const key = f.failureSummary || `(worker ${f.index} exit ${f.exitCode})`;
    bySummary.set(key, (bySummary.get(key) ?? 0) + 1);
  }
  process.stderr.write(
    `  round ${round}: ${n} workers, ${failed.length} failed, ${Math.round((Date.now() - started) / 1000)}s\n`,
  );
}

process.stdout.write(
  `\nload-flake summary: ${rounds} rounds × ${n} workers → ${failures.length} failing worker(s)\n`,
);
if (failures.length > 0) {
  process.stdout.write('failures by test:\n');
  for (const [key, count] of [...bySummary.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${count}× — ${key.replace(/\n/g, '\n         ')}\n`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'load-flake-'));
  for (const f of failures) {
    const name = `r${f.round}-w${f.index}.txt`;
    writeFileSync(join(dir, name), f.output, 'utf8');
  }
  process.stdout.write(`full outputs kept in ${dir}\n`);
} else {
  process.stdout.write('zero failures\n');
}

process.exit(failures.length > 0 ? 1 : 0);
