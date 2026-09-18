/**
 * E2E: a seam's surprise never costs the tree (ledger D23; jahala/pleach#120).
 *
 * Through the real CLI, real git and the real umbel adapter, driven against a
 * fake umbel binary this test writes: a bash script answering every verb the
 * adapter calls, as umbel's `contracts/runner.md` says umbel answers them. Its
 * `wait --json` is scripted per provider, call by call: the exit
 * code and the stdout to print — so a first wait can time out and a second
 * stop. The builder (claude) appends to work.txt in its cwd on every send, so
 * the tree holds work to keep; the auditor (codex) reads back whatever relay
 * the case wrote for it.
 *
 *  (a) The builder's wait exits 124 with {"reason":"timeout"} on both of two
 *      attempts: retried on the same tree, then settled failed with the tree on
 *      quarantine/<id> and a receipt counting both attempts.
 *  (b) The first wait exits 122 provider-error, the second stops: retried, and
 *      the node closes on its second attempt.
 *  (c) The builder stops green and the smoke passes, but the AUDITOR's wait
 *      exits 124: the tree is quarantined with a never-adjudicated audit
 *      record, and `pleach audit` re-runs that lane alone and closes it.
 *  (d) The wait exits 1 with no reason at all: a quarantine, and a receipt and
 *      verdict line carrying the seam's own text and the next step.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Receipt } from '../../src/core/receipt.ts';
import { createRepo, execLocal, gitIn } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

interface Summary {
  closed: string[];
  failed: string[];
  quarantined: string[];
}

type Line = Record<string, unknown>;

// A scripted wait: what `umbel wait --json` prints on stdout and how it exits.
// `stderr` is for the wait that names no reason at all.
interface Wait {
  exit: number;
  stdout?: string;
  stderr?: string;
}

// The fake umbel. Every verb the adapter calls, answered as umbel answers it;
// its state (each session's cwd and provider, each provider's wait script and
// how many waits it has served) lives in a directory outside every worktree.
function fakeUmbel(state: string): string {
  return `#!/usr/bin/env bash
S=${JSON.stringify(state)}
verb=$1; shift
case "$verb" in
  spawn)
    provider=claude
    while [ $# -gt 0 ]; do
      case "$1" in
        --name) name=$2; shift 2 ;;
        --cwd) cwd=$2; shift 2 ;;
        --provider) provider=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    printf '%s' "$cwd" > "$S/$name.cwd"
    printf '%s' "$provider" > "$S/$name.provider"
    echo "spawned: $name"
    ;;
  status) exit 0 ;;
  send)
    name=$2
    if [ "$(cat "$S/$name.provider")" = claude ]; then
      echo "worked" >> "$(cat "$S/$name.cwd")/work.txt"
    fi
    echo '{"sinceMtime":0}'
    ;;
  wait)
    name=\${!#}
    provider=$(cat "$S/$name.provider")
    n=$(( $(cat "$S/$provider.served" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$S/$provider.served"
    [ -f "$S/$provider.wait.$n.stdout" ] && cat "$S/$provider.wait.$n.stdout"
    [ -f "$S/$provider.wait.$n.stderr" ] && cat "$S/$provider.wait.$n.stderr" >&2
    exit "$(cat "$S/$provider.wait.$n.exit")"
    ;;
  read)
    name=$1
    if [ "$(cat "$S/$name.provider")" = codex ]; then
      cat "$S/codex.relay"
    else
      printf 'Appended a line to work.txt.\\n\\nTried: 2026-09-18 appended to work.txt; nothing rejected.\\n'
    fi
    ;;
  actions|diff|kill) exit 0 ;;
  *) echo "fake umbel: unknown verb $verb" >&2; exit 2 ;;
esac
`;
}

// The relay a passing auditor hands back: the fenced block the egress parses.
const PASSING_RELAY =
  '```tend-audit-result\n{"verdicts":[{"check":"work","verdict":"pass","reasons":[]}],"drift":[]}\n```\n';

describe('a seam’s surprise never costs the tree — e2e (D23)', () => {
  let repo = '';
  let state = '';
  let umbel = '';
  let planPath = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();

  // Script the next waits a provider's sessions will meet, starting over.
  async function scriptWaits(provider: 'claude' | 'codex', waits: Wait[]): Promise<void> {
    await rm(join(state, `${provider}.served`), { force: true });
    for (const [i, w] of waits.entries()) {
      const n = i + 1;
      await writeFile(join(state, `${provider}.wait.${n}.exit`), String(w.exit));
      await rm(join(state, `${provider}.wait.${n}.stdout`), { force: true });
      await rm(join(state, `${provider}.wait.${n}.stderr`), { force: true });
      if (w.stdout !== undefined) {
        await writeFile(join(state, `${provider}.wait.${n}.stdout`), `${w.stdout}\n`);
      }
      if (w.stderr !== undefined) {
        await writeFile(join(state, `${provider}.wait.${n}.stderr`), `${w.stderr}\n`);
      }
    }
  }

  async function served(provider: 'claude' | 'codex'): Promise<number> {
    return Number(
      (await readFile(join(state, `${provider}.served`), 'utf8').catch(() => '0')).trim(),
    );
  }

  async function writePlan(node: Record<string, unknown>): Promise<void> {
    await writeFile(
      planPath,
      JSON.stringify({
        goal: 'a surprise from the runner must not cost the tree',
        source: 'e2e-seam-keeps-tree',
        nodes: [
          { worker: { provider: 'claude' }, work: { prompt: 'append to work.txt' }, ...node },
        ],
      }),
    );
  }

  async function pleach(args: string[]): Promise<{ code: number; stdout: string }> {
    const proc = Bun.spawn(
      ['bun', MAIN, ...args, '--repo-root', repo, '--umbel-bin', umbel, '--quiet'],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', cwd: repo, env: process.env },
    );
    const [stdout, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code: code ?? 1, stdout };
  }

  async function run(): Promise<{ code: number; summary: Summary }> {
    const r = await pleach(['run', planPath]);
    return { code: r.code, summary: JSON.parse(r.stdout.trim()) as Summary };
  }

  async function verdictOf(node: string): Promise<Line> {
    const raw = await readFile(join(repo, '.git', 'pleach', 'journal.jsonl'), 'utf8');
    const verdicts = raw
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Line)
      .filter((l) => l.event === 'verdict' && l.node === node);
    return verdicts.at(-1) as Line;
  }

  async function receiptOf(node: string): Promise<Receipt> {
    const path = join(repo, '.git', 'pleach', 'receipts', `${node}.json`);
    return JSON.parse(await readFile(path, 'utf8')) as Receipt;
  }

  async function nodeBranches(): Promise<string> {
    return (await execLocal(['git', '-C', repo, 'for-each-ref', 'refs/heads/node/'], repo)).output;
  }

  async function worktrees(): Promise<number> {
    return (await gitIn(repo, 'worktree', 'list')).split('\n').length;
  }

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanup = r.cleanup;
    planPath = join(repo, 'plan.json');
    state = await mkdtemp(join(tmpdir(), 'pleach-fake-umbel-'));
    umbel = join(state, 'umbel');
    await writeFile(umbel, fakeUmbel(state));
    await chmod(umbel, 0o755);
  });

  afterEach(async () => {
    await cleanup();
    await rm(state, { recursive: true, force: true });
  });

  test('a wait that exits 124 with a timeout reason is retried, then settles failed with its tree kept', async () => {
    const timeout = { exit: 124, stdout: '{"reason":"timeout","message":"no stop in 30m"}' };
    await scriptWaits('claude', [timeout, timeout]);
    await writePlan({ id: 'slow', policy: { maxAttempts: 2 } });

    const { code, summary } = await run();
    expect(code).toBe(1);
    expect(summary.failed).toEqual(['slow']);
    expect(summary.quarantined).toEqual(['slow']);
    expect(await served('claude')).toBe(2);

    // Both attempts worked in the one tree, and all of it is kept.
    expect(await gitIn(repo, 'show', 'quarantine/slow:work.txt')).toBe('worked\nworked');
    const receipt = await receiptOf('slow');
    expect(receipt.facts.status).toBe('failed');
    expect(receipt.facts.attempts).toBe(2);
    expect(receipt.refs?.quarantineBranch).toBe('quarantine/slow');
    expect(await verdictOf('slow')).toMatchObject({ status: 'failed', attempts: 2 });

    expect((await nodeBranches()).trim()).toBe('');
    expect(await worktrees()).toBe(1);
  }, 60_000);

  test('a wait that exits 122 provider-error is retried and the node closes', async () => {
    await scriptWaits('claude', [
      { exit: 122, stdout: '{"reason":"provider-error","message":"API Error: 529 overloaded"}' },
      { exit: 0, stdout: '{"reason":"stop"}' },
    ]);
    await writePlan({ id: 'flaky', policy: { maxAttempts: 2 } });

    const { code, summary } = await run();
    expect(code).toBe(0);
    expect(summary.closed).toEqual(['flaky']);
    expect(await served('claude')).toBe(2);

    // The retry is on the record: the close took the second attempt, whose
    // work stands on the first's in the same tree.
    expect(await verdictOf('flaky')).toMatchObject({ status: 'done', attempts: 2 });
    expect((await receiptOf('flaky')).facts.attempts).toBe(2);
    expect(await gitIn(repo, 'show', 'node/flaky:work.txt')).toBe('worked\nworked');
    expect(await worktrees()).toBe(1);
  }, 60_000);

  test('an auditor whose wait times out over a green tree leaves it quarantined; `pleach audit` closes it', async () => {
    await scriptWaits('claude', [{ exit: 0, stdout: '{"reason":"stop"}' }]);
    await scriptWaits('codex', [{ exit: 124, stdout: '{"reason":"timeout"}' }]);
    await writePlan({
      id: 'audited',
      accept: {
        smoke: 'bash -lc "test -s work.txt"',
        audit: { command: 'bash -lc "true"', provider: 'codex' },
      },
      policy: { maxAttempts: 2 },
    });

    const { code, summary } = await run();
    expect(code).toBe(1);
    expect(summary.closed).toEqual([]);
    expect(summary.quarantined).toEqual(['audited']);
    expect(await served('claude')).toBe(1); // the build was never re-run

    expect(await gitIn(repo, 'show', 'quarantine/audited:work.txt')).toBe('worked');
    const quarantined = await receiptOf('audited');
    expect(quarantined.facts.gates.find((g) => g.gate === 'smoke')?.exitCode).toBe(0);
    expect(quarantined.facts.audit).toEqual([
      { check: '(audit)', verdict: 'skip', reasons: ['auditor timeout — never adjudicated'] },
    ]);
    expect((await nodeBranches()).trim()).toBe('');

    // The lane alone re-runs: a new auditor, no builder, and the node closes.
    await writeFile(join(state, 'codex.relay'), PASSING_RELAY);
    await scriptWaits('codex', [{ exit: 0, stdout: '{"reason":"stop"}' }]);
    const audit = await pleach(['audit', planPath, 'audited']);
    expect(audit.code).toBe(0);
    expect(await served('codex')).toBe(1);
    expect(await served('claude')).toBe(1);
    expect(await gitIn(repo, 'show', 'node/audited:work.txt')).toBe('worked');
    const closed = await receiptOf('audited');
    expect(closed.derived).toBe('publishable');
    expect(closed.refs?.previousReceiptSha256).toBe(quarantined.sha256);
    expect(await worktrees()).toBe(1);
  }, 60_000);

  test('a wait that exits 1 with no reason leaves a quarantine and a receipt with the seam’s text', async () => {
    await scriptWaits('claude', [{ exit: 1, stderr: 'umbel: tmux exploded' }]);
    await writePlan({ id: 'broken', policy: { maxAttempts: 2 } });

    const { code, summary } = await run();
    expect(code).toBe(1);
    expect(summary.failed).toEqual(['broken']);
    expect(summary.quarantined).toEqual(['broken']);

    expect(await gitIn(repo, 'show', 'quarantine/broken:work.txt')).toBe('worked');
    const receipt = await receiptOf('broken');
    expect(receipt.facts.status).toBe('failed');
    expect(receipt.facts.attempts).toBe(1);
    expect(receipt.refs?.quarantineBranch).toBe('quarantine/broken');

    const verdict = (await verdictOf('broken')) as {
      gate: { ran: string; outputTail: string };
      detail: string;
    };
    // The receipt's last gate is the seam's, sealing the very text the journal keeps.
    expect(receipt.facts.gates.at(-1)).toEqual({
      gate: 'seam:worker',
      exitCode: -1,
      outputTailSha: createHash('sha256').update(verdict.gate.outputTail, 'utf8').digest('hex'),
    });
    expect(verdict.gate.ran).toBe('seam:worker');
    expect(verdict.gate.outputTail).toContain('umbel: tmux exploded');
    expect(verdict.detail).toContain('wait exited 1: umbel: tmux exploded');
    expect(verdict.detail).toContain(
      'next: re-run the plan: the node resumes from quarantine/broken',
    );
    expect(await worktrees()).toBe(1);
  }, 60_000);
});
