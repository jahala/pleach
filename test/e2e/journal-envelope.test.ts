/**
 * E2E: the run journal a REAL run leaves behind is readable by the garden's
 * one loader. ledger: D15 (jahala/pleach#60, jahala/plotplot#16)
 *
 * The unit tests pin `envelope` as a function and the integration test pins
 * the seam; neither proves that what `pleach run` actually writes is what the
 * friction profile describes. So: the real CLI as a process, real git, a real
 * flaky smoke process and the bundled direct-cli runner driving a fake
 * `claude` binary (ENGINEERING's testing doctrine — no subscription, runs in
 * CI). Then EVERY line of the file, not a sampled one: one JSON object each,
 * the universal keys on all of them, a kind from the pinned four, the mirrors
 * a gate's line owes, and the verdict naming the runner that did the work.
 *
 * Two runs, because a run has two ways to reach a verdict: the ladder settles
 * one, and a surprise out of the node makes the other. Both are real runs and
 * both write a `verdict` line, so both owe the casting join its runner.
 *
 * The pinned kinds and keys are restated here rather than imported from
 * src/core/journal-envelope.ts on purpose: a reader of this journal has the
 * profile, not pleach's table, and a test that imported the table would pass
 * for any table.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepo } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

// The universal keys of contracts/friction-profile.md: on every line of every
// stream, whatever else the stream carries.
const UNIVERSAL = [
  'time',
  'event.name',
  'plotplot.kind',
  'plotplot.count',
  'plotplot.harness',
  'gen_ai.conversation.id',
] as const;

// The kinds the profile pins for pleach. Four, and no fifth: a kind invented
// per event is what the profile exists to prevent.
const KINDS = new Set(['gate.retry', 'run.lifecycle', 'node.lifecycle', 'gate.result']);

// The scopes a kind owes, under the profile's names — so one loader can group
// three streams by node or by gate without knowing any stream's field names.
const MIRRORS: Record<string, readonly string[]> = {
  'run.lifecycle': [],
  'node.lifecycle': ['plotplot.node'],
  'gate.result': ['plotplot.node', 'plotplot.gate'],
  'gate.retry': ['plotplot.node', 'plotplot.gate'],
};

// Fake `claude`: writes the file the smoke looks for, into its cwd (the tree).
const FAKE_CLAUDE = `#!/bin/sh
echo "built" > built.txt
echo "fake claude: done"
`;

const MODEL = 'claude-opus-5';

function plan(smoke: string) {
  return {
    goal: 'a real run leaves a journal the garden can read',
    source: 'e2e-journal-envelope',
    nodes: [
      {
        id: 'build',
        worker: { provider: 'claude', model: MODEL },
        work: { prompt: 'build the feature' },
        accept: { smoke },
        policy: { maxAttempts: 1 },
      },
      {
        id: 'follow',
        needs: ['build'],
        work: { command: 'bash -lc "test -f built.txt && echo followed > followed.txt"' },
        accept: { smoke: 'test -f followed.txt' },
        policy: { maxAttempts: 1 },
      },
    ],
  };
}

// A plan written for one runner, run with another. `--runner direct-cli` is
// the lean profile — two providers, no umbel — so a node cast to a third is
// refused by the adapter mid-turn. That refusal is a surprise out of the node,
// not a gate verdict: the other way a real run reaches a `verdict` line.
const REFUSED = [
  { id: 'refused-with-model', provider: 'gemini', model: 'gemini-2.5-pro' },
  { id: 'refused-plain', provider: 'ollama' },
] as const;

function refusedPlan() {
  return {
    goal: 'a run whose runner refuses the cast still says who was cast',
    source: 'e2e-journal-envelope',
    nodes: REFUSED.map((n) => ({
      id: n.id,
      worker: 'model' in n ? { provider: n.provider, model: n.model } : { provider: n.provider },
      work: { prompt: 'build the feature' },
      accept: { smoke: 'true' },
      policy: { maxAttempts: 1 },
    })),
  };
}

function refusedIds(): string[] {
  return REFUSED.map((n) => n.id as string).sort();
}

async function journalLines(repo: string): Promise<Record<string, unknown>[]> {
  const raw = await Bun.file(join(repo, '.git', 'pleach', 'journal.jsonl')).text();
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// The envelope, on every line of whatever the run wrote — the part of the
// claim that does not depend on which run this was.
function expectEnvelope(
  lines: readonly Record<string, unknown>[],
  window: { before: number; after: number },
): void {
  for (const line of lines) {
    const name = line.event;
    const where = `line ${JSON.stringify(line)}`;

    // One JSON object per line — not an array, not a scalar, not two.
    expect(typeof line, where).toBe('object');
    expect(Array.isArray(line), where).toBe(false);

    for (const key of UNIVERSAL) expect([key, Object.hasOwn(line, key)]).toEqual([key, true]);

    // An instant from this run, in UTC, said the one way the profile says it.
    const time = line.time as string;
    expect(typeof time, where).toBe('string');
    expect(time.endsWith('Z'), where).toBe(true);
    expect(new Date(time).toISOString(), where).toBe(time);
    const ms = Date.parse(time);
    expect(ms >= window.before && ms <= window.after, where).toBe(true);

    // The stream keeps its own `event`; the envelope's name sits beside it,
    // source-namespaced, so one loader can tell three streams apart.
    expect(typeof name, where).toBe('string');
    expect(line['event.name'], where).toBe(`pleach.${name as string}`);

    const kind = line['plotplot.kind'] as string;
    expect(KINDS.has(kind), `${where} — kind ${kind}`).toBe(true);
    expect(line['plotplot.count'], where).toBe(1);
    // pleach observes a runner's process, not a harness turn, and a run is
    // not one conversation: present and null, never absent.
    expect(line['plotplot.harness'], where).toBeNull();
    expect(line['gen_ai.conversation.id'], where).toBeNull();
    // The provider behind a CLI is not observable from pleach; it is never
    // guessed from the runner's name.
    expect(Object.hasOwn(line, 'gen_ai.provider.name'), where).toBe(false);

    for (const mirror of MIRRORS[kind] as readonly string[]) {
      expect([mirror, Object.hasOwn(line, mirror)], where).toEqual([mirror, true]);
    }
  }
}

describe('the run journal a real run writes — the friction profile envelope', () => {
  let repo = '';
  let cleanupRepo: () => Promise<void> = () => Promise.resolve();
  let binDir = '';

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanupRepo = r.cleanup;
    binDir = await mkdtemp(join(tmpdir(), 'pleach-journal-bin-'));
    await writeFile(join(binDir, 'claude'), FAKE_CLAUDE);
    await chmod(join(binDir, 'claude'), 0o755);
  });

  afterEach(async () => {
    await cleanupRepo();
    await rm(binDir, { recursive: true, force: true });
  });

  function runCli(planPath: string) {
    return Bun.spawn(
      ['bun', MAIN, 'run', planPath, '--repo-root', repo, '--runner', 'direct-cli'],
      {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: repo,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      },
    );
  }

  async function collect(proc: ReturnType<typeof runCli>) {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }

  test('every line of a real run carries the envelope, and the verdict names the runner', async () => {
    // A smoke that is red once and green on the gate's one same-tree re-run —
    // the flaky doctrine (D10), here only to make the run emit a `gate-retry`.
    // The sentinel lives outside the worktree so the retry sees the flake.
    const sentinel = join(repo, 'flaky.sentinel');
    const flaky = join(repo, 'flaky.sh');
    await writeFile(
      flaky,
      `#!/usr/bin/env bash\ntest -f built.txt || exit 1\nif [ -f "${sentinel}" ]; then exit 0; fi\ntouch "${sentinel}"\necho "transient red" >&2\nexit 1\n`,
    );

    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(plan(`bash ${flaky}`)));

    const before = Date.now();
    const { stdout, stderr, code } = await collect(runCli(planPath));
    const after = Date.now();

    expect({ code, stderr }).toMatchObject({ code: 0 });
    const summary = JSON.parse(stdout.trim()) as { closed: string[]; failed: string[] };
    expect(summary.failed).toEqual([]);
    expect(summary.closed.sort()).toEqual(['build', 'follow']);

    const lines = await journalLines(repo);
    // A real run, not a two-line stub: the ladder ran twice over.
    expect(lines.length).toBeGreaterThan(8);
    expectEnvelope(lines, { before, after });

    const names = lines.map((l) => l.event);
    expect(names[0]).toBe('run-start');
    expect(names[names.length - 1]).toBe('run-end');
    for (const required of ['node-start', 'verdict', 'closed']) {
      expect(names, `missing ${required}`).toContain(required);
    }

    // The gate's one same-tree re-run, scoped to the node and the gate it was.
    const retries = lines.filter((l) => l.event === 'gate-retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]?.['plotplot.kind']).toBe('gate.retry');
    expect(retries[0]?.['plotplot.node']).toBe('build');
    expect(retries[0]?.['plotplot.gate']).toBe('smoke');

    // Who ran the work, under the profile's names: the runner's CLI name
    // verbatim — the same fact the line's own `provider` field states.
    const verdicts = lines.filter((l) => l.event === 'verdict');
    expect(verdicts).toHaveLength(2);
    for (const verdict of verdicts) {
      expect(verdict['plotplot.runner']).toBe(verdict.provider);
      expect(typeof verdict['plotplot.runner']).toBe('string');
    }
    const build = verdicts.find((v) => v.node === 'build');
    expect(build?.['plotplot.runner']).toBe('claude');
    // The plan named a model, so the line says which.
    expect(build?.['gen_ai.request.model']).toBe(MODEL);
    // The plan named none for `follow`, and "never told us" is an absent key.
    const follow = verdicts.find((v) => v.node === 'follow');
    expect(Object.hasOwn(follow as object, 'gen_ai.request.model')).toBe(false);
  }, 120_000);

  test('a verdict born of a surprise names its runner too', async () => {
    const planPath = join(repo, 'plan.json');
    await writeFile(planPath, JSON.stringify(refusedPlan()));

    const before = Date.now();
    const { stdout, code } = await collect(runCli(planPath));
    const after = Date.now();

    // The refusal is the node's whole outcome: nothing verified, run exits 1.
    expect(code).toBe(1);
    const summary = JSON.parse(stdout.trim()) as { closed: string[]; failed: string[] };
    expect(summary.closed).toEqual([]);
    expect(summary.failed.sort()).toEqual(refusedIds());

    const lines = await journalLines(repo);
    expectEnvelope(lines, { before, after });

    // Every node that started reached a verdict, and every verdict says who
    // was cast — `provider` resolved (docs/journal.md: never absent) and
    // `plotplot.runner` mirroring it, whichever way the verdict was reached.
    const verdicts = lines.filter((l) => l.event === 'verdict');
    expect(verdicts.map((v) => v.node).sort()).toEqual(refusedIds());
    for (const node of REFUSED) {
      const verdict = verdicts.find((v) => v.node === node.id) as Record<string, unknown>;
      expect([node.id, verdict.provider]).toEqual([node.id, node.provider]);
      expect([node.id, verdict['plotplot.runner']]).toEqual([node.id, node.provider]);
      // The model rule does not change with the way the verdict was reached.
      const model = 'model' in node ? node.model : undefined;
      expect([node.id, verdict['gen_ai.request.model']]).toEqual([node.id, model]);
      expect([node.id, Object.hasOwn(verdict, 'gen_ai.request.model')]).toEqual([
        node.id,
        model !== undefined,
      ]);
    }
  }, 120_000);
});
