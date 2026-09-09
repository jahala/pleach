// Collection sets aside what is not delivery, BEFORE staging.  ledger: D14
// (jahala/pleach#74, #76, #79 — `git add` of an ignored scratch path exited 1
// and killed a FINISHED node, worktree and all.)
//
// Two halves, both proven here against REAL git:
//   (a) the pure predicate — core/delivery.ts partitionDelivery(paths, cwd);
//   (b) the seam's ignore check — IsolateSeam.ignored(cwd, paths);
// and the whole thing through runPlan: a node whose touched set names a
// scratch file, a friction journal, an ignored path and an absolute path
// outside the tree closes normally, its commit holding only the delivery.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { partitionDelivery } from '../../src/core/delivery.ts';
import type { Plan, Verdict } from '../../src/core/plan.ts';
import { buildDeps } from '../../src/faces/config.ts';
import type { LedgerSeam, RunnerSeam } from '../../src/loop/deps.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { exec } from '../../src/seams/exec.ts';
import { resolveGitDir } from '../../src/seams/gitdir.ts';
import { createIsolateSeam } from '../../src/seams/isolate.ts';
import { createRepo, gitIn } from '../support/git-repo.ts';

// ── (a) the pure predicate ───────────────────────────────────────────────────

describe('partitionDelivery — what is not delivery, decided without I/O', () => {
  const cwd = '/wt/node';

  test('ordinary worktree paths are delivery', () => {
    const { keep, setAside } = partitionDelivery(['src/app.ts', 'docs/readme.md'], cwd);
    expect(keep).toEqual(['src/app.ts', 'docs/readme.md']);
    expect(setAside).toEqual([]);
  });

  test('the scratch directory the work order names is never delivery', () => {
    const paths = ['.loop-scratch', '.loop-scratch/notes.md', '.loop-scratch/a/b/probe.ts'];
    const { keep, setAside } = partitionDelivery(paths, cwd);
    expect(keep).toEqual([]);
    expect(setAside).toEqual(paths);
  });

  test('the friction journal is never delivery; the rest of its directory is', () => {
    const { keep, setAside } = partitionDelivery(
      ['.plotplot/friction/2026-09.jsonl', '.plotplot/profile.json'],
      cwd,
    );
    expect(keep).toEqual(['.plotplot/profile.json']);
    expect(setAside).toEqual(['.plotplot/friction/2026-09.jsonl']);
  });

  test('a directory whose name merely starts with a set-aside prefix is delivery', () => {
    const paths = ['.loop-scratchy/keep.ts', '.plotplot/frictionless.md'];
    const { keep, setAside } = partitionDelivery(paths, cwd);
    expect(keep).toEqual(paths);
    expect(setAside).toEqual([]);
  });

  test('an absolute path inside the worktree is delivery, normalised to relative', () => {
    const { keep, setAside } = partitionDelivery([`${cwd}/src/app.ts`], cwd);
    expect(keep).toEqual(['src/app.ts']);
    expect(setAside).toEqual([]);
  });

  test('an absolute path inside the worktree is still judged by the set-aside rules', () => {
    const { keep, setAside } = partitionDelivery([`${cwd}/.loop-scratch/notes.md`], cwd);
    expect(keep).toEqual([]);
    expect(setAside).toEqual([`${cwd}/.loop-scratch/notes.md`]);
  });

  test('anything outside the worktree is set aside, verbatim', () => {
    const outside = ['/tmp/elsewhere/note.txt', '../sibling/file.ts', '/wt/node-other/f.ts'];
    const { keep, setAside } = partitionDelivery(outside, cwd);
    expect(keep).toEqual([]);
    expect(setAside).toEqual(outside);
  });

  test('the worktree root itself is not a delivery path', () => {
    const { keep, setAside } = partitionDelivery(['', '.', './', cwd], cwd);
    expect(keep).toEqual([]);
    expect(setAside).toEqual(['', '.', './', cwd]);
  });

  test('total: every input lands in exactly one bucket, nothing throws', () => {
    const odd = [
      '',
      '.',
      '..',
      '/',
      './src/app.ts',
      'a//b.ts',
      'src/../src/app.ts',
      '.loop-scratch/../src/app.ts',
      'src/../../escape.ts',
      `${cwd}/`,
      '名前.ts',
    ];
    const { keep, setAside } = partitionDelivery(odd, cwd);
    expect(keep.length + setAside.length).toBe(odd.length);
    // Normalisation resolves the traversals rather than trusting the string:
    // a path that walks back into the tree is delivery, one that walks out is not.
    expect(keep).toContain('src/app.ts');
    expect(setAside).toContain('src/../../escape.ts');
    expect(partitionDelivery([], cwd)).toEqual({ keep: [], setAside: [] });
  });
});

// ── (b) the seam's ignore check, against real git ────────────────────────────

describe('isolate seam — ignored()', () => {
  let repo = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanup = r.cleanup;
    await writeFile(join(repo, '.gitignore'), '.loop-scratch/\n*.log\nbuild/\n');
    // A tracked file that also matches an ignore pattern: `git add` accepts it,
    // so a change to it IS delivery and must never be set aside.
    await writeFile(join(repo, 'tracked.log'), 'tracked\n');
    await gitIn(repo, 'add', '-f', '.gitignore', 'tracked.log');
    await gitIn(repo, 'commit', '-m', 'ignore rules');
    await mkdir(join(repo, '.loop-scratch'), { recursive: true });
    await writeFile(join(repo, '.loop-scratch/probe.ts'), 'probe\n');
    await mkdir(join(repo, 'build'), { recursive: true });
    await writeFile(join(repo, 'build/out.log'), 'noise\n');
    await writeFile(join(repo, 'app.ts'), 'export const a = 1;\n');
    await writeFile(join(repo, 'tracked.log'), 'changed\n');
  });

  afterEach(async () => {
    await cleanup();
  });

  test('names exactly the paths git ignores', async () => {
    const seam = createIsolateSeam(exec, repo);
    const ignored = await seam.ignored(repo, [
      'app.ts',
      'build/out.log',
      '.loop-scratch/probe.ts',
      'tracked.log',
    ]);
    expect([...ignored].sort()).toEqual(['.loop-scratch/probe.ts', 'build/out.log']);
  });

  test('an ignore rule is about the path, not the file on disk', async () => {
    const seam = createIsolateSeam(exec, repo);
    expect(await seam.ignored(repo, ['build/never-written.log'])).toEqual([
      'build/never-written.log',
    ]);
  });

  test('nothing ignored is an answer, not a failure', async () => {
    const seam = createIsolateSeam(exec, repo);
    expect(await seam.ignored(repo, ['app.ts', 'src/new.ts'])).toEqual([]);
    expect(await seam.ignored(repo, [])).toEqual([]);
  });
});

// ── the whole collection, through runPlan against real git ───────────────────

// A real RunnerSeam: it writes the files into the worktree and reports the
// manifest, exactly as umbel's editor manifest does — including the absolute
// path (#79) and the scratch path (#74) that killed finished nodes.
function writingRunner(act: (cwd: string) => Promise<string[]>): RunnerSeam {
  return {
    async spawnWorker(spec) {
      return {
        async send() {},
        async wait() {
          return {
            finalMessage: 'built the delivery',
            filesTouched: await act(spec.cwd),
            reason: 'stop' as const,
            telemetry: {},
          };
        },
        async kill() {},
      };
    },
  };
}

describe('a finished node whose touched set names non-delivery', () => {
  let repo = '';
  let outside = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();
  const emitted: Verdict[] = [];

  const ledger: LedgerSeam = {
    async readClosed() {
      return new Map<string, string | null>();
    },
    async emitVerdict(v) {
      emitted.push(v);
      return { closed: v.status === 'done' };
    },
  };

  beforeEach(async () => {
    emitted.length = 0;
    const r = await createRepo();
    repo = r.path;
    outside = await mkdtemp(join(tmpdir(), 'pleach-outside-'));
    await writeFile(join(repo, '.gitignore'), '.loop-scratch/\n*.log\n');
    await gitIn(repo, 'add', '.gitignore');
    await gitIn(repo, 'commit', '-m', 'ignore rules');
    cleanup = async () => {
      await r.cleanup();
      await rm(outside, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  async function journalEvents(): Promise<Record<string, unknown>[]> {
    const text = await readFile(join(resolveGitDir(repo), 'pleach', 'journal.jsonl'), 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  const plan: Plan = {
    goal: 'collect only the delivery',
    source: 'docs/tend2/gate-artifacts.tend2.html',
    nodes: [
      {
        id: 'collect',
        worker: {},
        work: { prompt: 'build it' },
        needs: [],
        accept: {},
        policy: { maxAttempts: 1, onDead: 'fail', reauditWhen: [] },
        closes: [],
      },
    ],
  };

  test('closes normally; the commit holds the delivery and nothing else', async () => {
    const escapee = join(outside, 'stray-note.md');
    const deps = buildDeps({
      repoRoot: repo,
      ledger,
      runner: writingRunner(async (cwd) => {
        await mkdir(join(cwd, 'src'), { recursive: true });
        await writeFile(join(cwd, 'src/app.ts'), 'export const a = 1;\n');
        await mkdir(join(cwd, '.loop-scratch'), { recursive: true });
        await writeFile(join(cwd, '.loop-scratch/notes.md'), 'scratch\n');
        await mkdir(join(cwd, '.plotplot/friction'), { recursive: true });
        await writeFile(join(cwd, '.plotplot/friction/2026-09.jsonl'), '{"friction":1}\n');
        await writeFile(join(cwd, 'run.log'), 'ignored by *.log\n');
        await writeFile(escapee, 'written outside the worktree\n');
        // The manifest as umbel hands it over: an absolute path for the
        // delivery, an absolute path for the escapee, relative for the rest.
        return [
          join(cwd, 'src/app.ts'),
          '.loop-scratch/notes.md',
          '.plotplot/friction/2026-09.jsonl',
          'run.log',
          escapee,
        ];
      }),
    });

    const summary = await runPlan(plan, deps, { repoRoot: repo, defaultTimeoutMs: 60_000 });

    expect(summary.failed).toEqual([]);
    expect(summary.closed).toEqual(['collect']);

    const tree = (await gitIn(repo, 'ls-tree', '-r', '--name-only', 'node/collect'))
      .split('\n')
      .filter(Boolean);
    expect(tree).toContain('src/app.ts');
    expect(tree).not.toContain('.loop-scratch/notes.md');
    expect(tree).not.toContain('.plotplot/friction/2026-09.jsonl');
    expect(tree).not.toContain('run.log');
    expect(tree.some((f) => f.includes('stray-note.md'))).toBe(false);

    // The set-aside paths are named in the journal, not silently dropped.
    const setAside = (await journalEvents()).filter((e) => e.event === 'set-aside');
    expect(setAside.length).toBe(1);
    expect(setAside[0]?.node).toBe('collect');
    const paths = setAside[0]?.paths as string[];
    expect([...paths].sort()).toEqual(
      ['.loop-scratch/notes.md', '.plotplot/friction/2026-09.jsonl', 'run.log', escapee].sort(),
    );

    // The staged set the verdict and the receipt carry is the delivery only.
    const done = emitted.find((v) => v.node === 'collect');
    expect(done?.status).toBe('done');
    expect(done?.evidence.filesTouched).toContain('src/app.ts');
    expect(done?.evidence.filesTouched).not.toContain('.loop-scratch/notes.md');
    expect(done?.evidence.filesTouched).not.toContain(escapee);
  });

  test('a change to a tracked file that matches an ignore rule is still delivery', async () => {
    await writeFile(join(repo, 'keep.log'), 'tracked\n');
    await gitIn(repo, 'add', '-f', 'keep.log');
    await gitIn(repo, 'commit', '-m', 'tracked despite *.log');

    const deps = buildDeps({
      repoRoot: repo,
      ledger,
      runner: writingRunner(async (cwd) => {
        await writeFile(join(cwd, 'keep.log'), 'changed by the worker\n');
        return ['keep.log'];
      }),
    });

    const summary = await runPlan(plan, deps, { repoRoot: repo, defaultTimeoutMs: 60_000 });
    expect(summary.closed).toEqual(['collect']);
    expect(await gitIn(repo, 'show', 'node/collect:keep.log')).toBe('changed by the worker');

    const setAside = (await journalEvents()).filter((e) => e.event === 'set-aside');
    expect(setAside).toEqual([]);
  });
});
