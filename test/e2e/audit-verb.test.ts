/**
 * E2E: an unparseable audit relay costs one auditor turn, not the node
 * (ledger D17; jahala/pleach#77).
 *
 * Through the real CLI, real git and the bundled scripted runner: a node whose
 * build is green and whose auditor hands back prose instead of the fenced
 * block is quarantined with its smoke recorded green — and `pleach audit
 * <plan> <node>` re-runs ONLY the audit on it, seeded from quarantine/<id>,
 * closing it on a passing relay and re-quarantining it on a failing one. Both
 * halves of the claim are here: the journal line says what the parser looked
 * for and what it got, and the verb refuses anything that is not a quarantined
 * close with a green smoke.
 *
 * The smoke script counts its own runs in a file outside every worktree, and
 * the builder stamps the relay it ran under into app.txt, so "only the audit
 * re-ran" is a fact this test reads rather than a claim it trusts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Receipt } from '../../src/core/receipt.ts';
import { AUDITOR_PROSE } from '../fixtures/audit-verb.config.ts';
import { createRepo, execLocal, gitIn } from '../support/git-repo.ts';
import { ownFields } from '../support/journal.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const CONFIG = join(import.meta.dir, '../fixtures/audit-verb.config.ts');

// The close's own record plus what a re-adjudicated close adds: the tree it
// was seeded from (D17), so a resumed close stays distinguishable forever.
type CloseReceipt = Receipt & { facts: { base?: { kind: string; sha: string } } };

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Summary {
  closed: string[];
  failed: string[];
  quarantined: string[];
}

async function pleach(
  repo: string,
  args: string[],
  relay: 'garbage' | 'pass' | 'fail' = 'garbage',
): Promise<RunResult> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: repo,
    env: { ...process.env, PLEACH_TEST_AUDIT_RELAY: relay },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, stdout, stderr };
}

// lib closes plainly; app is the green build whose auditor relays prose;
// redsmoke is the node that fails its OWN gate — an audit has nothing to
// re-adjudicate there, and the verb must say so.
function plan(setupScript: string, smokeScript: string) {
  const audit = { command: 'bash -lc "true"', provider: 'codex' };
  return {
    goal: 'an unparseable audit relay must not cost the node',
    source: 'e2e-audit-verb',
    nodes: [
      { id: 'lib', work: { command: 'bash -lc "echo lib > lib.txt"' }, policy: { maxAttempts: 1 } },
      {
        id: 'app',
        needs: ['lib'],
        worker: { provider: 'claude' },
        work: { prompt: 'build the app' },
        setup: `bash ${setupScript}`,
        accept: { smoke: `bash ${smokeScript}`, audit },
        policy: { maxAttempts: 1 },
      },
      {
        id: 'redsmoke',
        worker: { provider: 'claude' },
        work: { prompt: 'build the flaky thing' },
        accept: { smoke: 'bash -lc "exit 1"', audit },
        policy: { maxAttempts: 1 },
      },
    ],
  };
}

async function journalEvents(repo: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(repo, '.git', 'pleach', 'journal.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readReceipt(repo: string, node: string): Promise<CloseReceipt> {
  const path = join(repo, '.git', 'pleach', 'receipts', `${node}.json`);
  return JSON.parse(await readFile(path, 'utf8')) as CloseReceipt;
}

async function branchSha(repo: string, branch: string): Promise<string | null> {
  const r = await execLocal(['git', '-C', repo, 'rev-parse', '--verify', branch], repo);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

describe('pleach audit — re-adjudicating a quarantined node (D17)', () => {
  let repo = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();
  let planPath = '';
  let counter = '';
  let setupCounter = '';

  // app's setup and smoke leave one line per run in files no worktree can
  // reach — the ladder's own tally of what was spent on it.
  async function runs(tally: string): Promise<number> {
    const text = await readFile(tally, 'utf8').catch(() => '');
    return text.split('\n').filter((line) => line !== '').length;
  }

  // The run that loses a green build to a relay defect: lib closes, app is
  // quarantined on unparseable egress, redsmoke on its own red smoke.
  async function runWithGarbageRelay(): Promise<Summary> {
    const r = await pleach(repo, ['run', planPath, '--config', CONFIG, '--repo-root', repo]);
    expect(r.code).toBe(1);
    return JSON.parse(r.stdout.trim()) as Summary;
  }

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanup = r.cleanup;
    counter = join(repo, 'smoke-runs.txt');
    setupCounter = join(repo, 'setup-runs.txt');
    const smokeScript = join(repo, 'smoke.sh');
    const setupScript = join(repo, 'setup.sh');
    await writeFile(smokeScript, `#!/usr/bin/env bash\necho ran >> "${counter}"\n`);
    await writeFile(setupScript, `#!/usr/bin/env bash\necho ran >> "${setupCounter}"\n`);
    planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(plan(setupScript, smokeScript)));
  });

  afterEach(async () => {
    await cleanup();
  });

  test('a prose relay quarantines a green build; `pleach audit` closes it on one auditor turn', async () => {
    const summary = await runWithGarbageRelay();
    expect(summary.closed).toEqual(['lib']);
    expect(summary.failed.sort()).toEqual(['app', 'redsmoke']);
    expect(summary.quarantined.sort()).toEqual(['app', 'redsmoke']);

    // The journal names the block the parser looked for and shows what came
    // back instead — the whole diagnosis of a relay defect, in one line.
    const unparseable = (await journalEvents(repo)).filter(
      (e) => e.event === 'audit-egress-unparseable' && e.node === 'app',
    );
    expect(unparseable.length).toBe(2); // the reaudit budget, spent on this one relay
    expect(ownFields(unparseable[0] as Record<string, unknown>)).toEqual({
      event: 'audit-egress-unparseable',
      node: 'app',
      reaudit: 0,
      expected: 'a fenced tend-audit-result block',
      egress: AUDITOR_PROSE,
    });

    // Nothing was wrong with the build: the smoke is recorded green and the
    // work is on quarantine/app, unpublished.
    const quarantined = await readReceipt(repo, 'app');
    expect(quarantined.derived).toBe('quarantined');
    expect(quarantined.facts.gates.find((g) => g.gate === 'smoke')?.exitCode).toBe(0);
    const quarantineSha = await gitIn(repo, 'rev-parse', 'quarantine/app');
    expect(await branchSha(repo, 'node/app')).toBeNull();
    expect(await runs(counter)).toBe(1);
    expect(await runs(setupCounter)).toBe(1);

    // A verified node has nothing to re-adjudicate, and a node whose own smoke
    // was red is not an audit's to fix. Both refuse, and a refusal writes
    // nothing: no new close, no branch moved.
    const libSha = await gitIn(repo, 'rev-parse', 'node/lib');
    const redBefore = await readReceipt(repo, 'redsmoke');
    const onVerified = await pleach(
      repo,
      ['audit', planPath, 'lib', '--config', CONFIG, '--repo-root', repo],
      'pass',
    );
    expect(onVerified.code).toBe(1);
    expect(onVerified.stderr).toContain('lib');
    expect(await gitIn(repo, 'rev-parse', 'node/lib')).toBe(libSha);

    const onRedSmoke = await pleach(
      repo,
      ['audit', planPath, 'redsmoke', '--config', CONFIG, '--repo-root', repo],
      'pass',
    );
    expect(onRedSmoke.code).toBe(1);
    expect(onRedSmoke.stderr).toContain('redsmoke');
    expect((await readReceipt(repo, 'redsmoke')).sha256).toBe(redBefore.sha256);
    expect(await branchSha(repo, 'node/redsmoke')).toBeNull();
    expect(await runs(setupCounter)).toBe(1); // a refusal provisions nothing

    // The relay defect costs one auditor turn: the node closes without a
    // second build.
    const audit = await pleach(
      repo,
      ['audit', planPath, 'app', '--config', CONFIG, '--repo-root', repo],
      'pass',
    );
    expect(audit.code).toBe(0);
    const nodeSha = await gitIn(repo, 'rev-parse', 'node/app');
    expect(JSON.parse(audit.stdout.trim())).toMatchObject({ node: 'app', sha: nodeSha });

    // Seeded from the quarantine with the dependency merged as a run would:
    // the builder's stamp is still the one it wrote in the run that lost it,
    // and lib's work is in the tree.
    expect(await gitIn(repo, 'show', 'node/app:app.txt')).toBe('built (relay=garbage)');
    expect(await gitIn(repo, 'show', 'node/app:lib.txt')).toBe('lib');
    // The audit alone was re-run — but in a tree provisioned like any other,
    // so the auditor's command has what it needs.
    expect(await runs(counter)).toBe(1);
    expect(await runs(setupCounter)).toBe(2);

    // A close of its own, standing on the one it followed.
    const closed = await readReceipt(repo, 'app');
    expect(closed.sha256).not.toBe(quarantined.sha256);
    expect(closed.derived).toBe('publishable');
    expect(closed.facts.base).toEqual({ kind: 'quarantine', sha: quarantineSha });
    expect(closed.refs?.diffRef).toBe(nodeSha);
    expect(closed.refs?.previousReceiptSha256).toBe(quarantined.sha256);
    expect(
      (await journalEvents(repo)).filter((e) => e.event === 'closed' && e.node === 'app').length,
    ).toBe(1);

    // The receipt verb verifies the new close and lists the one behind it.
    const verify = await pleach(repo, ['receipt', 'app', '--repo-root', repo]);
    expect(verify.code).toBe(0);
    const check = JSON.parse(verify.stdout.trim()) as {
      outcome: string;
      history: Record<string, unknown>[];
    };
    expect(check.outcome).toBe('pass');
    expect(check.history[0]).toMatchObject({
      sha256: quarantined.sha256,
      status: 'failed',
      derived: 'quarantined',
    });
  }, 180_000);

  test('an auditor that adjudicates and fails re-quarantines: a new receipt, nothing published', async () => {
    await runWithGarbageRelay();
    const first = await readReceipt(repo, 'app');

    const audit = await pleach(
      repo,
      ['audit', planPath, 'app', '--config', CONFIG, '--repo-root', repo],
      'fail',
    );
    expect(audit.code).toBe(1);
    expect(await branchSha(repo, 'node/app')).toBeNull();

    // A second close, not an overwritten one — and the work it judged is still
    // kept where the first run left it.
    const second = await readReceipt(repo, 'app');
    expect(second.sha256).not.toBe(first.sha256);
    expect(second.derived).toBe('quarantined');
    expect(second.refs?.previousReceiptSha256).toBe(first.sha256);
    expect(second.facts.audit?.some((a) => a.verdict === 'fail')).toBe(true);
    expect(await gitIn(repo, 'show', 'quarantine/app:app.txt')).toBe('built (relay=garbage)');
    expect(await runs(counter)).toBe(1);
    expect(await runs(setupCounter)).toBe(2);
  }, 180_000);
});
