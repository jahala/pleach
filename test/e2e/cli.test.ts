/**
 * E2E: `pleach run` / `pleach validate` as a real process.
 *
 * The full stack, no mocks: real git repo (a copy of the proof project), real
 * umbel binary driving the fake-claude fixture over tmux, real tend ingester
 * module (missoula source) as the ledger transport. Three nodes: a prompt node
 * (worker turn + smoke), a command node engineered to FAIL ONCE (exercises the
 * retry ladder), and a dependent command node (exercises close→baseRef flow).
 *
 * Gated loudly on the umbel binary + missoula module being present.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PLEACH_MAIN = join(import.meta.dir, '../../src/main.ts');
const PROOF_PROJECT = join(import.meta.dir, '../../examples/proof/project');
const PROOF_PLAN = join(import.meta.dir, '../../examples/proof/plan.json');
const FAKE_CLAUDE = join(import.meta.dir, '../fixtures/fake-claude.sh');
const UMBEL_BIN = process.env.PLEACH_UMBEL_BIN ?? '';
const TEND_MODULE = process.env.PLEACH_TEND_MODULE ?? '';
const MISSOULA_FILES = TEND_MODULE.replace('bridge/ingester.ts', 'files.js');

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const fullStack = (await exists(UMBEL_BIN)) && (await exists(TEND_MODULE.replace('.js', '.ts')));

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function pleach(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const proc = Bun.spawn(['bun', PLEACH_MAIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, stdout, stderr };
}

async function git(repo: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

// ── ungated: validate + usage errors ─────────────────────────────────────────

describe('pleach CLI — validate and usage', () => {
  test('validate on the proof plan: exit 0, topo order ends with the integration node', async () => {
    const r = await pleach(['validate', PROOF_PLAN]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim()) as { valid: boolean; order: string[] };
    expect(out.valid).toBe(true);
    expect(out.order[out.order.length - 1]).toBe('wordcount');
  });

  test('invalid plan JSON → exit 2', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'pleach-badplan-'));
    try {
      const bad = join(tmp, 'bad.json');
      await writeFile(bad, '{"goal": "x"}'); // missing source/nodes
      const r = await pleach(['validate', bad]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('pleach:');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('unknown verb → exit 2; no args → help + exit 2', async () => {
    const r1 = await pleach(['frobnicate', 'x.json']);
    expect(r1.code).toBe(2);
    const r2 = await pleach([]);
    expect(r2.code).toBe(2);
    expect(r2.stdout).toContain('pleach');
  });
});

// ── full stack ────────────────────────────────────────────────────────────────

describe.skipIf(!fullStack)('pleach run — full stack e2e', () => {
  let repo = '';
  let state = '';
  let jsonl = '';

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'pleach-e2e-repo-'));
    state = await mkdtemp(join(tmpdir(), 'pleach-e2e-state-'));
    jsonl = join(state, 'jsonl');
    await mkdir(jsonl, { recursive: true });

    await cp(PROOF_PROJECT, repo, { recursive: true });
    // The flaky-once command: fails on the first attempt, passes on the retry.
    await writeFile(
      join(repo, 'flaky.sh'),
      '#!/usr/bin/env bash\nif [ -f .sentinel ]; then exit 0; fi\ntouch .sentinel\necho "first attempt fails deliberately" >&2\nexit 1\n',
    );
    await git(repo, 'init', '-q');
    await git(repo, 'config', 'user.email', 'e2e@pleach');
    await git(repo, 'config', 'user.name', 'pleach-e2e');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'init');

    // Seed the catalog the ingester's readClosed requires (mirrors missoula's
    // own test fixtures — writeCatalog is the real writer).
    const missoula = (await import(MISSOULA_FILES)) as {
      writeCatalog: (catalog: unknown, root: string) => Promise<void>;
    };
    await missoula.writeCatalog(
      {
        schema_version: '1',
        project_id: 'pleach-e2e',
        status: 'draft',
        features: [{ id: 'wordcount', title: 'Wordcount Library', status: 'in-progress' }],
      },
      repo,
    );

    const plan = {
      goal: 'e2e: one worker turn + one flaky command + one dependent',
      source: repo,
      nodes: [
        {
          id: 'e1',
          work: { prompt: 'Reply with a short acknowledgement.' },
          accept: { smoke: 'bun test' },
        },
        { id: 'e2', work: { command: 'bash flaky.sh' } },
        { id: 'e3', needs: ['e1', 'e2'], work: { command: 'bun test' } },
      ],
    };
    await writeFile(join(repo, 'plan-e2e.json'), JSON.stringify(plan, null, 2));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  });

  test('three nodes close; retry happened; node branches published', async () => {
    const r = await pleach(
      [
        'run',
        join(repo, 'plan-e2e.json'),
        '--repo-root',
        repo,
        '--max-concurrency',
        '2',
        '--timeout-ms',
        '60000',
        '--umbel-bin',
        UMBEL_BIN,
        '--tend-module',
        TEND_MODULE,
      ],
      {
        UMBEL_STATE: state,
        UMBEL_CLAUDE_BIN: FAKE_CLAUDE,
        FAKE_CLAUDE_HOOK: join(state, 'hooks', 'stop.sh'),
        FAKE_CLAUDE_JSONL_DIR: jsonl,
        FAKE_CLAUDE_DELAY: '0',
      },
    );

    expect(r.stderr).toContain('pleach: running 3 nodes');
    const summary = JSON.parse(r.stdout.trim()) as {
      closed: string[];
      failed: string[];
      skipped: string[];
      blocked: string[];
    };
    expect(summary.failed).toEqual([]);
    expect(summary.blocked).toEqual([]);
    expect(summary.skipped).toEqual([]);
    expect(summary.closed.sort()).toEqual(['e1', 'e2', 'e3']);
    expect(r.code).toBe(0);

    // Verified branches exist and point at commits.
    for (const id of ['e1', 'e2', 'e3']) {
      const sha = await git(repo, 'rev-parse', '--verify', `node/${id}`);
      expect(sha.length).toBe(40);
    }

    // The retry is in the journal: a gate-fail for e2's command, then closed.
    const journal = await readFile(join(repo, '.git', 'pleach', 'journal.jsonl'), 'utf8');
    const events = journal
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const e2Closed = events.some((e) => e.event === 'closed' && e.node === 'e2');
    expect(e2Closed).toBe(true);
    // The retry is proven by hard evidence: flaky.sh fails its FIRST run and
    // creates .sentinel; only a second attempt can exit 0 — so a closed e2
    // whose commit contains .sentinel means the retry ladder ran.
    const sentinelCommitted = await git(repo, 'show', 'node/e2', '--stat');
    expect(sentinelCommitted).toContain('.sentinel');
  }, 180_000);
});
