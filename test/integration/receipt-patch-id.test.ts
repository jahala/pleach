// Integration: a receipt's refs survive a rebase or squash landing (issue
// #105). After a rebase-merge the landed commit has a new sha; after a squash
// several nodes' changes become one commit. When the `node/<id>` branch is then
// deleted (and the dangling commits pruned), the recorded sha no longer
// resolves and the receipt used to read `underivable` even though the work is
// on the branch — the record said the wrong thing.
//
// The fix: a verified close records the commit's stable patch-id (and its
// committer time) beside `diffRef`, outside the hashed envelope. At verify time
// the receipt resolves each ref through the patch-id of the sealed diff to the
// commit on the landed history that carries it, or reports itself orphaned with
// the reason, and never resolves it to the wrong commit.
//
// Real git in tmp dirs, the seams wired the way the CLI wires them; the worker
// is a real RunnerSeam that writes its delivery and stops. Every dangling
// commit is pruned before verify, so the patch-id path is what is exercised.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitLedger } from '../../src/adapters/git.ts';
import { PlanSchema } from '../../src/core/plan.ts';
import { type MintFacts, mintReceipt, type Receipt } from '../../src/core/receipt.ts';
import { buildDeps } from '../../src/faces/config.ts';
import type { RunnerSeam } from '../../src/loop/deps.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { resolveGitDir } from '../../src/seams/gitdir.ts';
import { createRepo, execLocal, gitIn } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const SOURCE = 'receipt-patch-id';

let repo = '';
let cleanup: () => Promise<void> = () => Promise.resolve();

beforeEach(async () => {
  const r = await createRepo();
  repo = r.path;
  cleanup = r.cleanup;
});

afterEach(async () => {
  await cleanup();
});

/** A real RunnerSeam that writes one named file and stops. */
function writingRunner(file: string, content: string): RunnerSeam {
  return {
    async spawnWorker(spec) {
      return {
        async send() {},
        async wait() {
          await writeFile(join(spec.cwd, file), content);
          return {
            finalMessage: 'built it',
            filesTouched: [file],
            reason: 'stop' as const,
            telemetry: {},
          };
        },
        async kill() {},
      };
    },
  };
}

/** Close one command-free node writing `file`; returns its node/<id> sha. */
async function closeNode(id: string, file: string, content: string): Promise<string> {
  const plan = PlanSchema.parse({
    goal: `build ${id}`,
    source: SOURCE,
    nodes: [{ id, work: { prompt: `build ${id}` }, policy: { maxAttempts: 1 } }],
  });
  const deps = buildDeps({
    repoRoot: repo,
    redaction: 'off',
    runner: writingRunner(file, content),
    ledger: gitLedger({ repo }),
  });
  const summary = await runPlan(plan, deps, { repoRoot: repo, defaultTimeoutMs: 60_000 });
  expect(summary.closed).toEqual([id]);
  return gitIn(repo, 'rev-parse', `node/${id}`);
}

async function receiptOf(id: string): Promise<Receipt> {
  const dir = join(resolveGitDir(repo), 'pleach', 'receipts');
  return JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')) as Receipt;
}

async function pleachReceipt(
  id: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', MAIN, 'receipt', id, '--repo-root', repo], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: repo,
    env: process.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, stdout, stderr };
}

async function defaultBranch(): Promise<string> {
  return gitIn(repo, 'symbolic-ref', '--short', 'HEAD');
}

/** Drop every dangling commit so a deleted node/<id> sha truly stops resolving. */
async function pruneDangling(): Promise<void> {
  await gitIn(repo, 'reflog', 'expire', '--expire=now', '--all');
  await gitIn(repo, 'gc', '--prune=now', '--quiet');
}

/** `git patch-id --stable` of `diff`, read through a stdin pipe. */
async function stablePatchId(diff: string): Promise<string> {
  const proc = Bun.spawn(['git', '-C', repo, 'patch-id', '--stable'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(diff);
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git patch-id --stable exited ${code}`);
  return out.trim().split(/\s+/)[0] ?? '';
}

function makeFacts(over: Partial<MintFacts> = {}): MintFacts {
  return {
    node: 'prechange',
    source: SOURCE,
    status: 'done',
    attempts: 1,
    provider: 'claude',
    gates: [{ gate: 'smoke:bun test', exitCode: 0 }],
    acceptance: { smoke: 'bun test' },
    degraded: ['audit:unconfigured'],
    stagedFiles: 1,
    telemetry: {},
    durationMs: 1000,
    pleachVersion: '0.0.1-test',
    redaction: 'plotplot',
    ...over,
  };
}

// ledger: #105
test('a verified close records refs.patchId, equal to git patch-id --stable of its diff', async () => {
  const sha = await closeNode('writer', 'work.txt', 'built\n');
  const receipt = await receiptOf('writer');

  expect(receipt.refs?.diffRef).toBe(sha);
  expect(receipt.refs?.patchId).toBeDefined();
  expect(receipt.refs?.closedAt).toBeTypeOf('number');

  const diff = (await execLocal(['git', '-C', repo, 'diff', `${sha}^`, sha], repo)).stdout;
  expect(receipt.refs?.patchId).toBe(await stablePatchId(diff));
}, 60_000);

// ledger: #105
test('a rebase-merge resolves the receipt by patch-id after the branch is deleted', async () => {
  await closeNode('writer', 'work.txt', 'built\n');
  const receipt = await receiptOf('writer');
  expect(receipt.refs?.patchId).toBeDefined();

  const target = await defaultBranch();
  // Move the target so the rebase changes the sha (message kept).
  await writeFile(join(repo, 'moved.txt'), 'moved\n');
  await gitIn(repo, 'add', '-A');
  await gitIn(repo, 'commit', '-m', 'move the target');

  await gitIn(repo, 'checkout', 'node/writer');
  await gitIn(repo, 'rebase', target);
  await gitIn(repo, 'checkout', target);
  await gitIn(repo, 'merge', '--ff-only', 'node/writer');
  await gitIn(repo, 'branch', '-D', 'node/writer');
  await pruneDangling();

  const res = await pleachReceipt('writer');
  const json = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
  expect(res.code).toBe(0);
  expect(json.outcome).toBe('pass');
  expect(json.resolvedBy).toBe('patch-id');
  expect(json.landedAs).toBe(await gitIn(repo, 'rev-parse', target));
  // A full close, a rebase, a gc prune and a spawned `pleach receipt`; under
  // five parallel suites this exceeds bun's 5 s default (issue #160 — measured
  // 5.2 s while failing). The bound catches a hang, never the git work.
}, 60_000);

// ledger: #105
test('a squash of two nodes orphans both receipts: no single commit carries the work', async () => {
  await closeNode('a', 'a.txt', 'built a\n');
  await closeNode('b', 'b.txt', 'built b\n');

  const target = await defaultBranch();
  await gitIn(repo, 'checkout', target);
  await gitIn(repo, 'merge', '--squash', 'node/a');
  await gitIn(repo, 'merge', '--squash', 'node/b');
  await gitIn(repo, 'commit', '-m', 'squash a and b');
  await gitIn(repo, 'branch', '-D', 'node/a');
  await gitIn(repo, 'branch', '-D', 'node/b');
  await pruneDangling();

  for (const id of ['a', 'b']) {
    const res = await pleachReceipt(id);
    const json = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
    expect(json.outcome).toBe('orphaned');
    expect(json.detail).toContain('no');
    expect(res.code).not.toBe(0);
  }
}, 60_000);

// ledger: #105
test('a squash of one node resolves by patch-id to the squash commit, without the trailer', async () => {
  await closeNode('a', 'a.txt', 'built a\n');

  const target = await defaultBranch();
  await gitIn(repo, 'checkout', target);
  await gitIn(repo, 'merge', '--squash', 'node/a');
  await gitIn(repo, 'commit', '-m', 'squash a');
  await gitIn(repo, 'branch', '-D', 'node/a');
  await pruneDangling();

  const res = await pleachReceipt('a');
  const json = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
  expect(json.outcome).toBe('pass');
  expect(json.resolvedBy).toBe('patch-id');
  expect(json.trailer).toBe(false);
  expect(json.landedAs).toBe(await gitIn(repo, 'rev-parse', target));
  expect(res.code).toBe(0);
}, 60_000);

// ledger: #105
test('a receipt written before this change (no patchId) verifies exactly as before', async () => {
  const minted = mintReceipt(makeFacts());
  await writeFile(join(repo, 'pre.txt'), 'pre\n');
  await gitIn(repo, 'add', '-A');
  await gitIn(repo, 'commit', '-m', `prechange\n\nreceipt-sha256: ${minted.sha256}`);
  const sha = await gitIn(repo, 'rev-parse', 'HEAD');
  const receipt: Receipt = { ...minted, refs: { diffRef: sha } };

  const dir = join(resolveGitDir(repo), 'pleach', 'receipts');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'prechange.json'), `${JSON.stringify(receipt, null, 2)}\n`);

  const res = await pleachReceipt('prechange');
  const json = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
  expect(res.code).toBe(0);
  expect(json.outcome).toBe('pass');
  expect(json.resolvedBy).toBeUndefined();
  expect(json.landedAs).toBeUndefined();
}, 60_000);

// ledger: #105
test('the history search stays correct at real size and is bounded by --since', async () => {
  const target = await defaultBranch();
  // A decoy: the same patch as the work, but committed BEFORE the close. The
  // search bounded by --since must not pick it.
  await writeFile(join(repo, 'work.txt'), 'built\n');
  await gitIn(repo, 'add', '-A');
  await gitIn(repo, 'commit', '-m', 'decoy work');
  await gitIn(repo, 'rm', '-q', 'work.txt');
  await gitIn(repo, 'commit', '-m', 'remove decoy');

  await closeNode('writer', 'work.txt', 'built\n');

  // A few thousand commits after the close.
  const head = await gitIn(repo, 'rev-parse', 'HEAD');
  const now = Math.floor(Date.now() / 1000);
  const stream: string[] = [];
  let prev = head;
  for (let i = 1; i <= 2000; i++) {
    const msg = `noise-${i}`;
    stream.push(`commit refs/heads/${target}`);
    stream.push(`mark :${i}`);
    stream.push(`committer Pleach Test <test@pleach.test> ${now + i} +0000`);
    stream.push(`data ${msg.length}`);
    stream.push(msg);
    stream.push(`from ${prev}`);
    stream.push('');
    prev = `:${i}`;
  }
  const fi = Bun.spawn(['git', '-C', repo, 'fast-import', '--quiet'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  fi.stdin.write(stream.join('\n'));
  fi.stdin.end();
  const fiErr = await new Response(fi.stderr).text();
  if ((await fi.exited) !== 0) throw new Error(`fast-import failed: ${fiErr}`);

  await gitIn(repo, 'checkout', 'node/writer');
  await gitIn(repo, 'rebase', target);
  await gitIn(repo, 'checkout', target);
  await gitIn(repo, 'merge', '--ff-only', 'node/writer');
  await gitIn(repo, 'branch', '-D', 'node/writer');
  await pruneDangling();

  const res = await pleachReceipt('writer');
  const json = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
  expect(json.outcome).toBe('pass');
  expect(json.resolvedBy).toBe('patch-id');
  // The landed commit, not the pre-close decoy that carries the same patch.
  expect(json.landedAs).toBe(await gitIn(repo, 'rev-parse', target));
}, 60_000);
