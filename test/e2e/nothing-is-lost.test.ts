/**
 * E2E: nothing a worker produced is lost (ledger D17), through the real CLI,
 * real git and the bundled scripted runner — the loop's sink.
 *
 * One plan walks the whole line. `feature` is a {test, phases} node whose turn
 * is cut by SIGINT after its red phase sealed (D13 + D16): the run settles it
 * aborted, keeps the half-written implementation on quarantine/feature and the
 * message the worker had already given beside the close. The re-run stands on
 * that tree instead of rebuilding from nothing — the red seal the interrupted
 * attempt earned is still in the published history, no second red is ever
 * sealed over a tree that could not honestly produce one, and the verified
 * close records `facts.base` so it stays distinguishable from a fresh one
 * forever. Both closes are on file, linked, and both hand-backs survive.
 *
 * `report` needs it, and its auditor relays prose instead of the fenced block:
 * a green build quarantined by a relay defect, which `pleach audit` closes on
 * one auditor turn. The builder stamps the relay it built under into
 * report.txt, so "the audit alone re-ran" is a fact this test reads.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Receipt } from '../../src/core/receipt.ts';
import {
  GREEN_HANDBACK,
  GREET_DONE,
  GREET_HALF_WRITTEN,
  INTERRUPTED_HANDBACK,
} from '../fixtures/nothing-is-lost.config.ts';
import { createRepo, execLocal, gitIn } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const CONFIG = join(import.meta.dir, '../fixtures/nothing-is-lost.config.ts');

// The tree this close was seeded from (D17) — sealed inside the envelope.
type CloseReceipt = Receipt & { facts: { base?: { kind: string; sha: string } } };

// The seed: greet() exists but greets nobody, so a genuinely failing test can
// exist and the red phase has something real to go red against.
const SEED = `export function greet(_name: string): string {
  return '';
}
`;

const PLAN = {
  goal: 'nothing a worker produced is lost',
  source: 'e2e-nothing-is-lost',
  nodes: [
    {
      id: 'feature',
      work: {
        test: 'bun test feature.test.ts',
        phases: [
          { phase: 'red', prompt: 'RED: write a failing test for greet()' },
          { phase: 'impl', prompt: 'IMPL: make the test pass' },
          { phase: 'green', prompt: 'GREEN: confirm the suite' },
        ],
      },
      accept: { smoke: 'bun test feature.test.ts' },
      policy: { maxAttempts: 1 },
    },
    {
      id: 'report',
      needs: ['feature'],
      worker: { provider: 'claude' },
      work: { prompt: 'REPORT: write the report' },
      accept: {
        smoke: 'bash -lc "test -f report.txt"',
        audit: { command: 'bash -lc "true"', provider: 'codex' },
      },
      policy: { maxAttempts: 1 },
    },
  ],
};

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Summary {
  closed: string[];
  failed: string[];
  skipped: string[];
  aborted: string[];
  quarantined: string[];
}

function spawnPleach(repo: string, args: string[], env: Record<string, string> = {}) {
  return Bun.spawn(['bun', MAIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: repo,
    env: { ...process.env, ...env },
  });
}

async function collect(proc: ReturnType<typeof spawnPleach>): Promise<RunResult> {
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, stdout, stderr };
}

async function pleach(
  repo: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  return collect(spawnPleach(repo, args, env));
}

/** Poll until the worker's turn has actually started, or fail loudly. */
async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new TypeError(`timed out after ${timeoutMs}ms waiting for ${path}`);
}

async function journalEvents(repo: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(repo, '.git', 'pleach', 'journal.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const eventsFor = (
  lines: readonly Record<string, unknown>[],
  event: string,
  node: string,
): Record<string, unknown>[] => lines.filter((l) => l.event === event && l.node === node);

async function readReceipt(repo: string, node: string): Promise<CloseReceipt> {
  const path = join(repo, '.git', 'pleach', 'receipts', `${node}.json`);
  return JSON.parse(await readFile(path, 'utf8')) as CloseReceipt;
}

async function handbackOf(receipt: Receipt): Promise<string> {
  const path = receipt.artifacts?.handback;
  if (path === undefined) throw new TypeError('the close kept no hand-back');
  return readFile(path, 'utf8');
}

/** Is `ancestor` in the history of `ref`? The whole claim of a resumed build. */
async function isAncestor(repo: string, ancestor: string, ref: string): Promise<boolean> {
  const r = await execLocal(
    ['git', '-C', repo, 'merge-base', '--is-ancestor', ancestor, ref],
    repo,
  );
  return r.exitCode === 0;
}

describe('nothing a worker produced is lost — e2e (D17)', () => {
  let repo = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();
  let planPath = '';
  let signals = '';

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanup = r.cleanup;
    await writeFile(join(repo, 'feature.ts'), SEED);
    await gitIn(repo, 'add', 'feature.ts');
    await gitIn(repo, 'commit', '-m', 'seed: greet() greets nobody');
    planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(PLAN));
    // The sentinel lives outside the repo: the run's own trees are the subject.
    signals = await mkdtemp(join(tmpdir(), 'pleach-nothing-lost-'));
  });

  afterEach(async () => {
    await cleanup();
    await rm(signals, { recursive: true, force: true });
  });

  // ledger: D17 — the interrupted build, resumed; the bad relay, re-adjudicated.
  test('an interrupted phased node resumes and closes verified; a bad relay costs one auditor turn', async () => {
    // ── the run that is cut mid-implementation ────────────────────────────
    const halt = join(signals, 'impl-started');
    const interrupted = spawnPleach(
      repo,
      ['run', planPath, '--config', CONFIG, '--repo-root', repo],
      { PLEACH_TEST_HALT: halt },
    );
    await waitForFile(halt, 60_000);
    interrupted.kill('SIGINT');
    const first = await collect(interrupted);
    const halted = JSON.parse(first.stdout.trim()) as Summary;

    expect(first.code).toBe(1);
    expect(halted.aborted).toEqual(['feature']);
    expect(halted.quarantined).toEqual(['feature']);
    expect(halted.skipped).toEqual(['report']);
    expect(halted.closed).toEqual([]);

    // The red seal is history, and the half-written implementation came with
    // it: what the worker was holding is on the quarantine, unpublished.
    const sealed = eventsFor(await journalEvents(repo), 'phase-commit', 'feature');
    expect(sealed.map((e) => e.phase)).toEqual(['red']);
    const redSha = String(sealed[0]?.sha);
    const quarantineSha = await gitIn(repo, 'rev-parse', 'quarantine/feature');
    expect(await isAncestor(repo, redSha, quarantineSha)).toBe(true);
    expect(await gitIn(repo, 'show', 'quarantine/feature:feature.ts')).toBe(
      GREET_HALF_WRITTEN.trim(),
    );
    const nodeRefs = await execLocal(['git', '-C', repo, 'for-each-ref', 'refs/heads/node/'], repo);
    expect(nodeRefs.output.trim()).toBe('');

    // And the message the worker had already given is kept beside its close.
    const aborted = await readReceipt(repo, 'feature');
    expect(aborted.facts.status).toBe('aborted');
    expect(aborted.derived).toBe('quarantined');
    expect(await handbackOf(aborted)).toBe(INTERRUPTED_HANDBACK);

    // ── the re-run, standing on the tree the halt left behind ─────────────
    const rerun = await pleach(repo, ['run', planPath, '--config', CONFIG, '--repo-root', repo]);
    const resumed = JSON.parse(rerun.stdout.trim()) as Summary;

    expect(resumed.closed).toEqual(['feature']);
    // report is the next section's subject: its build is green, its auditor
    // relays prose, so the run ends red with the node quarantined.
    expect(resumed.failed).toEqual(['report']);
    expect(resumed.quarantined).toEqual(['report']);
    expect(rerun.code).toBe(1);

    const events = await journalEvents(repo);
    expect(eventsFor(events, 'resumed-from-quarantine', 'feature')).toMatchObject([
      { node: 'feature', sha: quarantineSha },
    ]);
    // Resumed, not rebuilt: the seal the interrupted attempt earned is in the
    // published history — and no second red was sealed, because a tree that
    // already carries the failing test cannot honestly produce one.
    const featureSha = await gitIn(repo, 'rev-parse', 'node/feature');
    expect(await isAncestor(repo, redSha, featureSha)).toBe(true);
    expect(eventsFor(events, 'phase-commit', 'feature').map((e) => e.phase)).toEqual(['red']);
    expect(await gitIn(repo, 'show', 'node/feature:feature.ts')).toBe(GREET_DONE.trim());

    // A close of its own, standing on the one it followed — and every gate ran
    // over a tree nothing had gated before.
    const verified = await readReceipt(repo, 'feature');
    expect(verified.derived).toBe('publishable');
    expect(verified.facts.base).toEqual({ kind: 'quarantine', sha: quarantineSha });
    expect(verified.facts.gates.map((g) => g.gate)).toEqual(['marker', 'hygiene', 'smoke']);
    expect(verified.refs?.previousReceiptSha256).toBe(aborted.sha256);

    // Both hand-backs survive: the finished turn's beside the latest close, the
    // interrupted turn's still under its own close's name.
    expect(await handbackOf(verified)).toBe(GREEN_HANDBACK);
    expect(await handbackOf(aborted)).toBe(INTERRUPTED_HANDBACK);

    // The receipt verb verifies the latest close and lists the one behind it.
    const check = await pleach(repo, ['receipt', 'feature', '--repo-root', repo]);
    expect(check.code).toBe(0);
    expect(JSON.parse(check.stdout.trim())).toMatchObject({
      outcome: 'pass',
      history: [{ sha256: aborted.sha256, status: 'aborted', derived: 'quarantined' }],
    });

    // ── the relay defect: one auditor turn, not the node ──────────────────
    const unparseable = eventsFor(events, 'audit-egress-unparseable', 'report');
    expect(unparseable.length).toBeGreaterThan(0);
    expect(unparseable[0]).toMatchObject({ expected: 'a fenced tend-audit-result block' });
    const relayed = await readReceipt(repo, 'report');
    expect(relayed.derived).toBe('quarantined');
    expect(relayed.facts.gates.find((g) => g.gate === 'smoke')?.exitCode).toBe(0);
    const reportQuarantineSha = await gitIn(repo, 'rev-parse', 'quarantine/report');

    const audit = await pleach(
      repo,
      ['audit', planPath, 'report', '--config', CONFIG, '--repo-root', repo],
      { PLEACH_TEST_AUDIT_RELAY: 'pass' },
    );
    expect(audit.code).toBe(0);
    const reportSha = await gitIn(repo, 'rev-parse', 'node/report');
    expect(JSON.parse(audit.stdout.trim())).toMatchObject({ node: 'report', sha: reportSha });

    // The audit alone re-ran: the stamp is the one the builder wrote in the run
    // that lost it, and the verified feature is in the tree it was judged in.
    expect(await gitIn(repo, 'show', 'node/report:report.txt')).toBe('report (relay=garbage)');
    expect(await gitIn(repo, 'show', 'node/report:feature.ts')).toBe(GREET_DONE.trim());

    const readjudicated = await readReceipt(repo, 'report');
    expect(readjudicated.derived).toBe('publishable');
    expect(readjudicated.facts.base).toEqual({
      kind: 'quarantine',
      sha: reportQuarantineSha,
    });
    expect(readjudicated.refs?.previousReceiptSha256).toBe(relayed.sha256);
  }, 300_000);
});
