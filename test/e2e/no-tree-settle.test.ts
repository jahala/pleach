/**
 * E2E: a linked-worktree root plus a gate that cannot run settles failed with
 * the gate's own reason, and never reports a catastrophic isolate failure
 * (issue #100).
 *
 * The umbrella conducts from a linked git worktree, whose `.git` is a FILE
 * (a pointer to the real git dir), not a directory. Before ledger D22 the git
 * dir inherited a relative `--repo-root`, the worktree path stayed relative,
 * and the isolate seam ran `git -C <rel>` with `cwd: <rel>` — resolved twice,
 * the second time from inside the worktree where `.git` is a file — so the
 * preserve step threw ENOTDIR and the journal read "could not preserve failed
 * work". There was a tree to keep; the path to it was broken.
 *
 * This pins the scenario end-to-end: a linked-worktree root passed relative AND
 * absolute, a node whose smoke names a binary nothing has (a gate that cannot
 * run, D19), the run settles failed with the gate's own reason, the partial
 * tree is preserved on quarantine/<id>, and no `quarantine-failed` line lands
 * in the journal.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execLocal, gitIn } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

// A binary no machine has; the flag makes it read like a real gate (D19).
const MISSING_SMOKE = 'definitely-not-a-binary-xyz --flag';

// The work appends a line so the quarantined tree is non-empty: the preserve
// step has something to snapshot, and the test proves it lands, not that it
// was skipped for emptiness.
const WORK = 'bash -lc "echo ran >> runs.txt"';

const PLAN = {
  goal: 'a gate that cannot run settles failed with its own reason',
  source: 'e2e-no-tree-settle',
  nodes: [{ id: 'fragile', work: { command: WORK }, accept: { smoke: MISSING_SMOKE } }],
};

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function pleach(args: string[], cwd: string): Promise<RunResult> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd,
    env: process.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, stdout, stderr };
}

async function journalEvents(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('a linked-worktree root and a gate that cannot run (issue #100)', () => {
  let parent = '';
  let base = '';
  let linked = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'pleach-linked-'));
    base = join(parent, 'base');
    linked = join(parent, 'linked');
    await execLocal(['git', 'init', base], parent);
    await gitIn(base, 'config', 'user.email', 'test@pleach.test');
    await gitIn(base, 'config', 'user.name', 'Pleach Test');
    await writeFile(join(base, 'init.txt'), 'init\n');
    await gitIn(base, 'add', 'init.txt');
    await gitIn(base, 'commit', '-m', 'initial');
    // A linked worktree: its .git is a FILE pointing at the real git dir.
    await gitIn(base, 'worktree', 'add', '-q', linked, '-b', 'linkedbranch');
    cleanup = async () => {
      await execLocal(['git', '-C', base, 'worktree', 'remove', '--force', linked], parent);
      await rm(parent, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  // The paths are computed inside the test body: `parent`, `base` and `linked`
  // are set by beforeEach, so they are only valid then, never at registration.
  for (const relative of [false, true]) {
    const name = relative ? 'relative repo-root' : 'absolute repo-root';

    test(`${name}: settles failed with the gate reason, preserves the tree, no quarantine-failed`, async () => {
      const repoRoot = relative ? basename(linked) : linked;
      const cwd = relative ? parent : linked;
      const planPath = join(parent, 'plan.json');
      const journal = join(parent, `journal-${name.replaceAll(' ', '-')}.jsonl`);
      await writeFile(planPath, JSON.stringify(PLAN));

      const run = await pleach(
        ['run', '--no-redact', planPath, '--repo-root', repoRoot, '--journal', journal],
        cwd,
      );

      expect(run.code).toBe(1);
      const summary = JSON.parse(run.stdout.trim()) as { failed: string[]; quarantined: string[] };
      expect(summary.failed).toEqual(['fragile']);
      expect(summary.quarantined).toEqual(['fragile']);

      // The gate's own reason reaches the journal; the preserve step never
      // fails, so no "catastrophic isolate failure" line is written.
      const events = (await journalEvents(journal)).filter((e) => e.node === 'fragile');
      const kinds = events.map((e) => e.event);
      expect(kinds).not.toContain('quarantine-failed');
      const verdict = events.find((e) => e.event === 'verdict') as {
        status: string;
        detail?: string;
        gate?: { ran: string; exitCode: number };
      };
      expect(verdict.status).toBe('failed');
      expect(verdict.gate?.ran).toBe(MISSING_SMOKE);
      expect(verdict.gate?.exitCode).toBe(127);
      expect(verdict.detail).toContain('environment');

      // The partial tree was preserved on the quarantine branch — reachable
      // from the linked worktree's own git dir — and nothing leaked.
      expect(await gitIn(linked, 'show', 'quarantine/fragile:runs.txt')).toBe('ran');
      expect((await gitIn(base, 'worktree', 'list')).split('\n').length).toBe(2);
    }, 60_000);
  }
});
