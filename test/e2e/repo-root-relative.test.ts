/**
 * E2E: a relative `--repo-root` works from any cwd (ledger D22, jahala/pleach#102).
 *
 * The face resolves the root once, so no seam ever sees a relative path. The
 * isolate seam runs `git -C <root>` with `cwd: <root>`; a root that is not `.`
 * was resolved twice — once by the cwd, once by `-C` from inside it — and the
 * first worktree add failed before any node ran.
 */
import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createRepo, execLocal } from '../support/git-repo.ts';

const PLEACH_MAIN = join(import.meta.dir, '../../src/main.ts');

test('pleach run with a relative --repo-root, run from the parent directory, closes the node', async () => {
  const { path: repo, cleanup } = await createRepo();
  try {
    const planPath = join(repo, 'plan.json');
    await writeFile(
      planPath,
      JSON.stringify({
        goal: 'a relative repo root is resolved once',
        source: 'e2e-repo-root-relative',
        nodes: [
          {
            id: 'rel',
            work: { command: 'bash -lc "echo rel > rel.txt"' },
            policy: { maxAttempts: 1 },
          },
        ],
      }),
    );

    const proc = Bun.spawn(
      [
        'bun',
        PLEACH_MAIN,
        'run',
        planPath,
        '--repo-root',
        basename(repo),
        '--max-concurrency',
        '1',
      ],
      { cwd: dirname(repo), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect({
      code,
      stderr: stderr
        .split('\n')
        .filter((l) => l.includes('fatal'))
        .join('\n'),
    }).toEqual({
      code: 0,
      stderr: '',
    });
    const summary = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as { closed?: string[] };
    expect(summary.closed).toEqual(['rel']);
    const branches = (await execLocal(['git', '-C', repo, 'branch', '--list', 'node/rel'], repo))
      .output;
    expect(branches).toContain('node/rel');
  } finally {
    await cleanup();
  }
}, 60_000);
