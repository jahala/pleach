// issue #127 — the seam's recordTree/treeDiffPaths against real git, and the
// loop's settle against them: a background command started before the stop is
// still writing when the settle begins, and the settled tree the gate reads
// contains the late write.
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecFn } from '../../src/loop/deps.ts';
import { settleWorkingTree } from '../../src/loop/settle.ts';
import { createIsolateSeam } from '../../src/seams/isolate.ts';

// Local ExecFn (Bun.spawn arg-arrays), as in isolate.test.ts.
const execLocal: ExecFn = async (argv, { cwd, env }) => {
  const proc = Bun.spawn(argv as string[], {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { output: out + err, stdout: out, exitCode };
};

async function gitIn(repo: string, ...args: string[]): Promise<string> {
  const r = await execLocal(['git', '-C', repo, ...args], { cwd: repo });
  if (r.exitCode !== 0) {
    throw new Error(`git -C ${repo} ${args.join(' ')} exited ${r.exitCode}:\n${r.output}`);
  }
  return r.output.trim();
}

async function createRepo(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'pleach-test-'));
  await execLocal(['git', 'init', path], { cwd: tmpdir() });
  await gitIn(path, 'config', 'user.email', 'test@pleach.test');
  await gitIn(path, 'config', 'user.name', 'Pleach Test');
  await writeFile(join(path, 'initial.txt'), 'initial\n');
  await gitIn(path, 'add', 'initial.txt');
  await gitIn(path, 'commit', '-m', 'initial');
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

test('the settle waits out a background write, and the settled tree contains the late file', async () => {
  const repo = await createRepo();
  try {
    const seam = createIsolateSeam(execLocal, repo.path);
    const cwd = repo.path;

    // A worker's background command, still running when it reports stop: the
    // file lands about 300ms in, inside the settle's first window.
    Bun.spawn(['bash', '-c', 'sleep 0.3; echo late > late.txt'], {
      cwd,
      stdout: 'ignore',
      stderr: 'ignore',
    });

    const outcome = await settleWorkingTree(
      'x',
      cwd,
      {
        isolate: seam,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        journal: { append: async () => {} },
      },
      undefined,
      { windowMs: 500, boundMs: 5000 },
    );

    expect(outcome.kind).toBe('settled');
    // The gate's view — a record of the settled tree — contains late.txt.
    expect(await readFile(join(cwd, 'late.txt'), 'utf8')).toBe('late\n');
  } finally {
    await repo.cleanup();
  }
});
