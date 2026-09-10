// ledger: D19 — the receipt's facts are the facts (jahala/pleach#73, #81).
// `stagedFiles` counted the set the loop handed to `git add`: every path the
// worker said it touched plus every path git saw change. A worker that named a
// file it never changed inflated the count, though the index held nothing for
// it. And a `verdict` journal line named a provider and model for a {command}
// node no worker ever ran, with nothing on the line to say so. The count is
// now the index after staging (the isolate seam answers from `git diff
// --cached --name-only`), and every verdict line carries `spawned` beside the
// cast it names: `provider` keeps its promise (resolved, never absent) and
// `spawned` says whether that cast ever ran the work.
//
// The seam's answer is proven against REAL git in this file, because the claim
// is that the count comes from the index and only real git has one. The loop's
// use of it runs on the in-memory harness.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IsolateCatastrophicError, WorkerSpawnError } from '../../src/core/errors.ts';
import { type AuditResult, PlanSchema } from '../../src/core/plan.ts';
import { auditNode } from '../../src/loop/audit-node.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { exec } from '../../src/seams/exec.ts';
import { createIsolateSeam } from '../../src/seams/isolate.ts';
import { createRepo, gitIn } from '../support/git-repo.ts';
import { type Harness, makeHarness, stop } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };

function plan(nodes: unknown[]) {
  return PlanSchema.parse({ goal: 'g', source: 's', nodes });
}

// ── the seam's answer, against real git ─────────────────────────────────────

describe('isolate seam — stagedPaths() answers from the index', () => {
  let repo = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanup = r.cleanup;
    for (const f of ['unchanged.ts', 'edited.ts', 'gone.ts']) {
      await writeFile(join(repo, f), `${f}\n`);
    }
    await gitIn(repo, 'add', '-A');
    await gitIn(repo, 'commit', '-m', 'tracked files');
  });

  afterEach(async () => {
    await cleanup();
  });

  test('names what staging put in the index: not what the worker named, not all that changed', async () => {
    await writeFile(join(repo, 'edited.ts'), 'edited.ts\nand more\n');
    await unlink(join(repo, 'gone.ts'));
    await writeFile(join(repo, 'fresh.ts'), 'fresh\n');
    // A non-ASCII name comes back as the path itself, never git's quoted form.
    await writeFile(join(repo, 'naïve.ts'), 'naive\n');
    // Changed in the tree but never handed to staging: git sees it, the index does not.
    await writeFile(join(repo, 'stray.ts'), 'stray\n');
    const seam = createIsolateSeam(exec, repo);

    // What a worker's report can hold beside its real work: a tracked file it
    // never changed, and a file that does not exist.
    await seam.stage(repo, [
      'unchanged.ts',
      'edited.ts',
      'gone.ts',
      'fresh.ts',
      'naïve.ts',
      'ghost.ts',
    ]);

    const staged = await seam.stagedPaths(repo);
    expect([...staged].sort()).toEqual(['edited.ts', 'fresh.ts', 'gone.ts', 'naïve.ts']);
  });

  test('a worker that changed nothing it named stages nothing', async () => {
    const seam = createIsolateSeam(exec, repo);
    await seam.stage(repo, ['unchanged.ts', 'ghost.ts']);
    expect(await seam.stagedPaths(repo)).toEqual([]);
  });

  test('a cwd git cannot read fails closed: an unreadable index is never a count of zero', async () => {
    const notARepo = await mkdtemp(join(tmpdir(), 'pleach-not-a-repo-'));
    try {
      const seam = createIsolateSeam(exec, repo);
      await expect(seam.stagedPaths(notARepo)).rejects.toBeInstanceOf(IsolateCatastrophicError);
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });
});

// ── ReceiptFacts.stagedFiles: the index, through the loop ───────────────────

// The worker's report names a file it never changed (README.md) beside the one
// it did; the tree also holds a scratch probe, which is never delivery. After
// staging, the index holds one path.
const TOUCHED = ['src/app.ts', 'README.md'];
const CHANGED = ['src/app.ts', '.loop-scratch/probe.ts'];

describe('ReceiptFacts.stagedFiles counts the index after staging', () => {
  test('a close counts what the index holds, not what the worker said it touched', async () => {
    const h = makeHarness({
      changedByNode: { x: CHANGED },
      waitScript: () => stop({ filesTouched: TOUCHED }),
    });
    const summary = await runPlan(
      plan([{ id: 'x', work: { prompt: 'build x' }, policy: { maxAttempts: 1 } }]),
      h.deps,
      OPTS,
    );

    expect(summary.closed).toEqual(['x']);
    expect(h.receipts.get('x')?.facts.stagedFiles).toBe(1);
  });

  test('a quarantine counts the index too', async () => {
    const h = makeHarness({
      changedByNode: { x: CHANGED },
      waitScript: () => stop({ filesTouched: TOUCHED }),
      execScript: (argv) =>
        argv[0] === 'smokey' ? { output: 'red', exitCode: 1 } : { output: '', exitCode: 0 },
    });
    const summary = await runPlan(
      plan([
        {
          id: 'x',
          work: { prompt: 'build x' },
          accept: { smoke: 'smokey' },
          policy: { maxAttempts: 1 },
        },
      ]),
      h.deps,
      OPTS,
    );

    expect(summary.quarantined).toEqual(['x']);
    expect(h.receipts.get('x')?.facts.stagedFiles).toBe(1);
  });

  // The same fact decides the red seal (D13): a red phase whose worker names a
  // file it never changed stages nothing, and a seal over an empty index would
  // claim a failing test that was never written (real git refuses the commit
  // outright, and the node died with no receipt).
  test('a red phase that names a file it never changed seals nothing and retries at red', async () => {
    const h = makeHarness({
      changedByNode: { p: [] },
      waitScript: () => stop({ filesTouched: ['test/app.test.ts'] }),
      execScript: (argv) =>
        argv[0] === 'runtests'
          ? { output: 'error: no test files found', exitCode: 1 }
          : { output: '', exitCode: 0 },
    });
    const summary = await runPlan(
      plan([
        {
          id: 'p',
          work: {
            test: 'runtests',
            phases: [
              { phase: 'red', prompt: 'write the failing test' },
              { phase: 'impl', prompt: 'make it pass' },
              { phase: 'green', prompt: 'run the suite' },
            ],
          },
          policy: { maxAttempts: 2 },
        },
      ]),
      h.deps,
      OPTS,
    );

    expect(summary.failed).toEqual(['p']);
    expect(h.log.count('commit')).toBe(0);
    expect(h.journal.some((e) => e.event === 'phase-commit')).toBe(false);
    expect(h.log.events.some((e) => e.kind === 'send' && e.detail === 'build:make it pass')).toBe(
      false,
    );
    expect(h.receipts.get('p')?.facts.attempts).toBe(2);
  });
});

// ── `spawned` on every verdict line ─────────────────────────────────────────

// The binary the environment does not have, and the exec seam's answer for it
// (src/seams/exec.ts resolves a spawn failure as 127 with the error as output).
const MISSING = 'pleach-no-such-binary';

function auditBlock(verdict: 'pass' | 'fail'): string {
  const body: AuditResult = { verdicts: [{ check: 'c', verdict, reasons: [] }], drift: [] };
  return `\`\`\`tend-audit-result\n${JSON.stringify(body)}\n\`\`\``;
}

function verdictLines(h: Harness, node: string): Record<string, unknown>[] {
  return h.journal.filter((e) => e.event === 'verdict' && e.node === node);
}

function onlyVerdictLine(h: Harness, node: string): Record<string, unknown> {
  const lines = verdictLines(h, node);
  expect(lines).toHaveLength(1);
  return lines[0] as Record<string, unknown>;
}

describe('every verdict journal line carries `spawned` beside the cast it names', () => {
  test('a {command} node: spawned false, and provider and model still name the cast', async () => {
    const h = makeHarness();
    await runPlan(
      plan([
        {
          id: 'c',
          worker: { provider: 'gemini', model: 'gemini-2.5-pro' },
          work: { command: 'make build' },
        },
      ]),
      h.deps,
      OPTS,
    );

    expect(h.log.count('spawn:build', 'c')).toBe(0);
    expect(onlyVerdictLine(h, 'c')).toMatchObject({
      status: 'done',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      spawned: false,
    });
  });

  test('a {command} node with an audit: the auditor ran, the cast did not, so spawned is false', async () => {
    const h = makeHarness({ auditEgress: () => auditBlock('pass') });
    await runPlan(
      plan([
        {
          id: 'c',
          work: { command: 'make build' },
          accept: { audit: { command: 'audit c', provider: 'codex' } },
        },
      ]),
      h.deps,
      OPTS,
    );

    expect(h.log.count('spawn:audit', 'c')).toBe(1);
    expect(onlyVerdictLine(h, 'c')).toMatchObject({
      status: 'done',
      provider: 'claude',
      spawned: false,
    });
  });

  test('a prompt node whose worker ran: spawned true', async () => {
    const h = makeHarness();
    await runPlan(plan([{ id: 'p', work: { prompt: 'build p' } }]), h.deps, OPTS);

    expect(h.log.count('spawn:build', 'p')).toBe(1);
    expect(onlyVerdictLine(h, 'p')).toMatchObject({
      status: 'done',
      provider: 'claude',
      spawned: true,
    });
  });

  test('a prompt node whose setup cannot run settles before any worker: spawned false', async () => {
    const h = makeHarness({
      execScript: (argv) =>
        argv[0] === MISSING
          ? { output: `Executable not found in $PATH: "${MISSING}"`, exitCode: 127 }
          : { output: '', exitCode: 0 },
    });
    await runPlan(
      plan([{ id: 'p', setup: `${MISSING} --init`, work: { prompt: 'build p' } }]),
      h.deps,
      OPTS,
    );

    expect(h.log.count('spawn:build', 'p')).toBe(0);
    expect(onlyVerdictLine(h, 'p')).toMatchObject({
      status: 'failed',
      provider: 'claude',
      spawned: false,
    });
  });

  test('a worker that ran on an earlier attempt: spawned true, though the last attempt settled before spawning', async () => {
    // Attempt 1 provisions, spawns, and its smoke is red; attempt 2's setup can
    // no longer spawn. The cast ran this node's work once, and the line says so.
    let setups = 0;
    const h = makeHarness({
      execScript: (argv) => {
        if (argv[0] === 'provision') {
          setups += 1;
          return setups === 1
            ? { output: '', exitCode: 0 }
            : { output: 'Executable not found in $PATH: "provision"', exitCode: 127 };
        }
        return argv[0] === 'smokey' ? { output: 'red', exitCode: 1 } : { output: '', exitCode: 0 };
      },
    });
    await runPlan(
      plan([
        {
          id: 'p',
          setup: 'provision',
          work: { prompt: 'build p' },
          accept: { smoke: 'smokey' },
          policy: { maxAttempts: 2 },
        },
      ]),
      h.deps,
      OPTS,
    );

    expect(h.log.count('spawn:build', 'p')).toBe(1);
    expect(onlyVerdictLine(h, 'p')).toMatchObject({
      status: 'failed',
      attempts: 2,
      provider: 'claude',
      spawned: true,
    });
  });

  test('a node that throws before its worker spawns: the failed line says spawned false', async () => {
    const h = makeHarness();
    h.deps.runner.spawnWorker = async () => {
      throw new WorkerSpawnError('umbel spawn exited 1: no such provider');
    };
    await runPlan(plan([{ id: 'p', work: { prompt: 'build p' } }]), h.deps, OPTS);

    expect(onlyVerdictLine(h, 'p')).toMatchObject({
      status: 'failed',
      provider: 'claude',
      spawned: false,
    });
  });

  test('a node that throws after its worker ran: the failed line says spawned true', async () => {
    const h = makeHarness();
    h.deps.isolate.stage = async () => {
      throw new IsolateCatastrophicError('git add -A', 'exited 128: index.lock exists');
    };
    await runPlan(plan([{ id: 'p', work: { prompt: 'build p' } }]), h.deps, OPTS);

    expect(h.log.count('spawn:build', 'p')).toBe(1);
    expect(onlyVerdictLine(h, 'p')).toMatchObject({
      status: 'failed',
      provider: 'claude',
      spawned: true,
    });
  });

  test('a re-adjudication (`pleach audit`): the auditor ran, the cast did not, so spawned is false', async () => {
    // The build's auditor fails it; the re-audit's auditor passes the same tree.
    const h = makeHarness({
      auditEgress: (ctx) => auditBlock(ctx.spawnIndex === 0 ? 'fail' : 'pass'),
    });
    const p = plan([
      {
        id: 'x',
        work: { prompt: 'build x' },
        accept: { smoke: 'smokey', audit: { command: 'audit x', provider: 'codex' } },
        policy: { maxAttempts: 1 },
      },
    ]);
    const summary = await runPlan(p, h.deps, OPTS);
    expect(summary.quarantined).toEqual(['x']);

    const reaudit = await auditNode(p, 'x', h.deps, { repoRoot: OPTS.repoRoot });
    expect(reaudit.status).toBe('closed');

    const [build, readjudicated] = verdictLines(h, 'x');
    expect(build).toMatchObject({ status: 'failed', provider: 'claude', spawned: true });
    expect(readjudicated).toMatchObject({ status: 'done', provider: 'claude', spawned: false });
    expect(h.log.count('spawn:build', 'x')).toBe(1);
  });
});
