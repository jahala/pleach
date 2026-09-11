/**
 * E2E: the record survives what the repository does (ledger D21), through the
 * real CLI + real git. No runner and no mocks: every plan is {command} work.
 *
 *  (a) A repository whose pre-commit hook refuses every commit. The node's
 *      work is done, the verified commit is refused, and the node settles
 *      failed with the hook's own words: its tree kept on quarantine/<id> by a
 *      snapshot the hook cannot refuse, its receipt written, nothing published.
 *
 *  (b) A run journal deleted between two runs. The next run journals a
 *      `journal-gap` for every receipt the journal no longer witnesses, and
 *      the first run's own lines are still kept beside the receipts.
 *
 *  (c) A node that writes BLOCKED.md, whether its command then exits 0 or not.
 *      It has finished and explained: it settles blocked on its one attempt
 *      with the file's text, and the file itself is kept on quarantine/<id>.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepo, execLocal, gitIn } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

interface Summary {
  closed: string[];
  failed: string[];
  blocked: string[];
  quarantined: string[];
  alreadyVerified: string[];
}

interface Receipt {
  sha256: string;
  facts: {
    node: string;
    status: string;
    gates: { gate: string; exitCode: number; outputTailSha?: string }[];
  };
  refs?: { diffRef?: string; quarantineBranch?: string; quarantineSha?: string };
}

type Line = Record<string, unknown>;

async function pleachRun(
  repo: string,
  planPath: string,
): Promise<{ code: number; summary: Summary; stderr: string }> {
  const proc = Bun.spawn(['bun', MAIN, 'run', planPath, '--repo-root', repo], {
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
  return { code: code ?? 1, summary: JSON.parse(stdout.trim()) as Summary, stderr };
}

const pleachDir = (repo: string): string => join(repo, '.git', 'pleach');
const journalPath = (repo: string): string => join(pleachDir(repo), 'journal.jsonl');

function parseLines(raw: string): Line[] {
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Line);
}

async function journalLines(repo: string): Promise<Line[]> {
  return parseLines(await readFile(journalPath(repo), 'utf8'));
}

async function receiptOf(repo: string, node: string): Promise<Receipt> {
  return JSON.parse(
    await readFile(join(pleachDir(repo), 'receipts', `${node}.json`), 'utf8'),
  ) as Receipt;
}

async function nodeBranches(repo: string): Promise<string> {
  return (await execLocal(['git', '-C', repo, 'for-each-ref', 'refs/heads/node/'], repo)).output;
}

describe('the record survives what the repository does — e2e', () => {
  let repo = '';
  let planPath = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanup = r.cleanup;
    planPath = join(repo, 'plan.json');
  });

  afterEach(async () => {
    await cleanup();
  });

  // ledger: D21 — a refused commit is a gate verdict like any other.
  test('a pre-commit hook that refuses commits: failed node, snapshot quarantine, receipt', async () => {
    // The hook is the repository's own, committed and reached through a
    // relative core.hooksPath — so it runs in every worktree pleach makes, as
    // it did in the planted repository (#96).
    const hooks = join(repo, '.githooks');
    await mkdir(hooks);
    await writeFile(
      join(hooks, 'pre-commit'),
      '#!/bin/sh\necho "house rule 7: no commits from this tree" >&2\nexit 1\n',
    );
    await chmod(join(hooks, 'pre-commit'), 0o755);
    await gitIn(repo, 'add', '.githooks/pre-commit');
    await gitIn(repo, 'commit', '-m', 'the house hook');
    await gitIn(repo, 'config', 'core.hooksPath', '.githooks');
    const base = await gitIn(repo, 'rev-parse', 'HEAD');

    await writeFile(
      planPath,
      JSON.stringify({
        goal: 'a refused commit must not cost the node its work',
        source: 'e2e-record-survives-hook',
        nodes: [
          {
            id: 'built',
            work: { command: 'bash -lc "echo finished > built.txt"' },
            policy: { maxAttempts: 1 },
          },
        ],
      }),
    );

    const { code, summary } = await pleachRun(repo, planPath);
    expect(code).toBe(1);
    expect(summary.failed).toEqual(['built']);
    expect(summary.closed).toEqual([]);
    expect(summary.quarantined).toEqual(['built']);

    // The refusal is the commit gate's verdict, in the hook's own words.
    const lines = (await journalLines(repo)).filter((l) => l.node === 'built');
    expect(lines.find((l) => l.event === 'gate-fail')).toMatchObject({ gate: 'commit' });
    const verdict = lines.find((l) => l.event === 'verdict') as {
      status: string;
      gate: { ran: string; outputTail: string };
    };
    expect(verdict.status).toBe('failed');
    expect(verdict.gate.ran).toBe('commit');
    expect(verdict.gate.outputTail).toContain('house rule 7: no commits from this tree');

    // The tree is kept by a snapshot the hook never saw: the finished file on
    // quarantine/built, standing on the commit the node started from.
    expect(await gitIn(repo, 'show', 'quarantine/built:built.txt')).toBe('finished');
    expect(await gitIn(repo, 'rev-parse', 'quarantine/built^')).toBe(base);

    // The receipt is written, carries the hook's output — the refusing gate's
    // record seals the hash of the very tail the journal keeps — and names the
    // quarantine.
    const receipt = await receiptOf(repo, 'built');
    expect(receipt.facts.status).toBe('failed');
    expect(receipt.facts.gates.at(-1)).toEqual({
      gate: 'commit',
      exitCode: -1,
      outputTailSha: createHash('sha256').update(verdict.gate.outputTail, 'utf8').digest('hex'),
    });
    expect(receipt.refs?.quarantineBranch).toBe('quarantine/built');
    expect(receipt.refs?.quarantineSha).toBe(await gitIn(repo, 'rev-parse', 'quarantine/built'));

    // Nothing published, no tree left behind.
    expect((await nodeBranches(repo)).trim()).toBe('');
    expect((await gitIn(repo, 'worktree', 'list')).split('\n').length).toBe(1);
  }, 60_000);

  // ledger: D21 — the journal can be lost and still be recovered.
  test('a deleted journal: the next run journals the gap, the first run’s copy is kept', async () => {
    await writeFile(
      planPath,
      JSON.stringify({
        goal: 'the receipts witness the journal',
        source: 'e2e-record-survives-journal',
        nodes: [
          {
            id: 'kept',
            work: { command: 'bash -lc "echo kept > kept.txt"' },
            policy: { maxAttempts: 1 },
          },
        ],
      }),
    );

    const first = await pleachRun(repo, planPath);
    expect(first.code).toBe(0);
    expect(first.summary.closed).toEqual(['kept']);

    // The first run's lines, as the journal held them before it was lost.
    const firstRaw = await readFile(journalPath(repo), 'utf8');
    const firstLines = parseLines(firstRaw);
    const runStart = firstLines.find((l) => l.event === 'run-start') as { runId: string };
    const runEnd = firstLines.find((l) => l.event === 'run-end') as { journalCopy: string };
    expect(typeof runStart.runId).toBe('string');
    expect(runEnd.journalCopy).toBe(
      join(pleachDir(repo), 'receipts', 'runs', `${runStart.runId}.journal.jsonl`),
    );
    const receipt = await receiptOf(repo, 'kept');

    await unlink(journalPath(repo));

    const second = await pleachRun(repo, planPath);
    expect(second.code).toBe(0);
    expect(second.summary.alreadyVerified).toEqual(['kept']);

    // The new journal names what the lost one no longer witnesses.
    const gaps = (await journalLines(repo)).filter((l) => l.event === 'journal-gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ node: 'kept', receiptSha256: receipt.sha256 });
    expect(Number.isNaN(Date.parse(String(gaps[0]?.closedAt)))).toBe(false);

    // The first run's copy survived beside the receipts: every line it wrote,
    // from its run-start to its run-end, verbatim.
    const copy = await readFile(runEnd.journalCopy, 'utf8');
    expect(copy).toBe(firstRaw);
    const copied = parseLines(copy).map((l) => l.event);
    expect(copied[0]).toBe('run-start');
    expect(copied.at(-1)).toBe('run-end');
    expect(copied).toContain('verdict');
  }, 60_000);

  // ledger: D21 — BLOCKED.md is a verdict, not a reason to retry. The file is
  // the explanation; how the command that wrote it then exited is not — a
  // script that explains and exits non-zero has explained all the same (#93).
  test.each([
    ['exits 0', 0],
    ['exits non-zero', 3],
  ])(
    'a node that writes BLOCKED.md and %s settles blocked in one attempt with the file’s text',
    async (_, exit) => {
      // The attempt count is kept outside the repo: the run's trees are the subject.
      const signals = await mkdtemp(join(tmpdir(), 'pleach-record-survives-'));
      const attempts = join(signals, 'attempts');
      try {
        await writeFile(
          planPath,
          JSON.stringify({
            goal: 'a worker that explains is not asked again',
            source: 'e2e-record-survives-blocked',
            nodes: [
              {
                id: 'stuck',
                work: {
                  command: `bash -lc "echo attempt >> ${attempts}; printf 'The registry at registry.test refuses this network.' > BLOCKED.md; exit ${exit}"`,
                },
                policy: { maxAttempts: 3 },
              },
            ],
          }),
        );

        const { code, summary } = await pleachRun(repo, planPath);
        expect(code).toBe(1);
        expect(summary.blocked).toEqual(['stuck']);
        expect(summary.closed).toEqual([]);
        expect(summary.failed).toEqual([]);
        expect(summary.quarantined).toEqual(['stuck']);

        // One attempt, though three were allowed.
        expect((await readFile(attempts, 'utf8')).trim().split('\n')).toEqual(['attempt']);
        const verdict = (await journalLines(repo)).find(
          (l) => l.event === 'verdict' && l.node === 'stuck',
        );
        expect(verdict).toMatchObject({
          status: 'blocked',
          attempts: 1,
          blockedReason: 'The registry at registry.test refuses this network.',
        });

        // The explanation is the evidence: kept on the quarantine, never published.
        expect(await gitIn(repo, 'show', 'quarantine/stuck:BLOCKED.md')).toBe(
          'The registry at registry.test refuses this network.',
        );
        expect((await receiptOf(repo, 'stuck')).facts.status).toBe('blocked');
        expect((await nodeBranches(repo)).trim()).toBe('');
        expect((await gitIn(repo, 'worktree', 'list')).split('\n').length).toBe(1);
      } finally {
        await rm(signals, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
