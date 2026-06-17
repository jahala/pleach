// Shared git-repo helpers for integration tests — real git repos in tmp dirs, no mocks.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const execLocal = async (
  argv: string[],
  cwd: string,
): Promise<{ output: string; exitCode: number }> => {
  const proc = Bun.spawn(argv, {
    cwd,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { output: out + err, exitCode };
};

export async function gitIn(repo: string, ...args: string[]): Promise<string> {
  const r = await execLocal(['git', '-C', repo, ...args], repo);
  if (r.exitCode !== 0) {
    throw new Error(`git -C ${repo} ${args.join(' ')} exited ${r.exitCode}:\n${r.output}`);
  }
  return r.output.trim();
}

export async function createRepo(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'pleach-test-'));
  await execLocal(['git', 'init', path], tmpdir());
  await gitIn(path, 'config', 'user.email', 'test@pleach.test');
  await gitIn(path, 'config', 'user.name', 'Pleach Test');
  // Initial commit so we can create branches
  await writeFile(join(path, 'init.txt'), 'init\n');
  await gitIn(path, 'add', 'init.txt');
  await gitIn(path, 'commit', '-m', 'initial');
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

/** Create a branch, make a commit on it, return to the default branch. Returns the commit SHA. */
export async function makeBranch(repo: string, branch: string): Promise<string> {
  await gitIn(repo, 'checkout', '-b', branch);
  await writeFile(join(repo, `${branch.replace(/\//g, '-')}.txt`), `${branch}\n`);
  await gitIn(repo, 'add', '-A');
  await gitIn(repo, 'commit', '-m', `branch ${branch}`);
  const sha = await gitIn(repo, 'rev-parse', 'HEAD');
  const branches = (await execLocal(['git', '-C', repo, 'branch'], repo)).output;
  const defaultBranch = branches.includes('master') ? 'master' : 'main';
  await gitIn(repo, 'checkout', defaultBranch);
  return sha;
}
