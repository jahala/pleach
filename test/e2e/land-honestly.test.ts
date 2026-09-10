/**
 * E2E: landing reads the map and does not wait on the whole run (ledger D18).
 *
 * The real CLI over real git, command-only plans — no runner is ever spawned,
 * so this runs everywhere CI does, like land.test.ts. Three questions only the
 * assembled face can answer:
 *
 *   · `--land-gate CMD` refuses a landing whose composed stack would leave a
 *     stamped claim stale — asked with a fixture gate that reads `{base}`
 *     (test/fixtures/land-gate.sh), and with the real `tend2 gate` when that
 *     binary is on this machine. pleach never imports or requires tend2; the
 *     tend2 case skips honestly where it is absent (CI), and the fixture gate
 *     — the same shape, minus the map — carries the claim there.
 *   · the same landing lands once the gate is green.
 *   · `pleach land --sinks` lands one verified node while another process
 *     holds the RUN lock, because a landing takes a lock of its own.
 *   · `pleach run --land --sinks` lands that same subset — the landing inside
 *     a run is the same landing, and a flag the face drops on the floor is a
 *     landing that says one thing and does another.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRepo, execLocal, gitIn } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const LAND_GATE = join(import.meta.dir, '../fixtures/land-gate.sh');
const HOLD_LOCK = join(import.meta.dir, '../fixtures/hold-lock.ts');
// Present on a maintainer's machine, absent in CI — the tend2 case is real or
// it is skipped; it is never faked.
const TEND2 = Bun.which('tend2');

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
    env: process.env,
    cwd,
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

/** Every pleach lockfile in the repo's git dir, name → the pid it names. */
async function lockFiles(repo: string): Promise<Record<string, number | null>> {
  const dir = join(repo, '.git');
  const names = (await readdir(dir)).filter((f) => f.startsWith('pleach-')).sort();
  const found: Record<string, number | null> = {};
  for (const name of names) {
    const pid = Number((await readFile(join(dir, name), 'utf8')).trim());
    found[name] = Number.isFinite(pid) && pid > 0 ? pid : null;
  }
  return found;
}

// One node that MOVES the file a claim is stamped on — the landing the gate
// exists to catch, and the shape that hid on weeder: a rename leaves the
// stamped path in no rename-detecting diff at all.
const STAMP_PLAN = {
  goal: 'a node that moves stamped evidence',
  source: 'e2e-land-honestly',
  nodes: [
    {
      id: 'mover',
      work: { command: 'bash -lc "mkdir -p docs/v2 && git mv docs/evidence.txt docs/v2/"' },
    },
  ],
};

const TWO_NODE_PLAN = {
  goal: 'two independent nodes, one landed early',
  source: 'e2e-land-honestly-sinks',
  nodes: [
    { id: 'settled', work: { command: 'bash -lc "echo settled > settled.txt"' } },
    { id: 'later', work: { command: 'bash -lc "echo later > later.txt"' } },
  ],
};

describe('pleach land — the map gate and the land lock, through the real CLI', () => {
  let repo = '';
  let journal = '';
  let planPath = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();
  const holders: ReturnType<typeof Bun.spawn>[] = [];

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    journal = join(repo, 'journal.jsonl');
    planPath = join(repo, 'plan.json');
    cleanup = r.cleanup;
  });

  afterEach(async () => {
    for (const holder of holders) {
      if (holder.exitCode === null) {
        holder.kill('SIGKILL');
        await holder.exited;
      }
    }
    holders.length = 0;
    await cleanup();
  });

  // ledger: D18 — the gate an operator names, on the composition, before publish.
  test('a land gate reading {base} refuses the stale landing; the same landing lands once it is green', async () => {
    await mkdir(join(repo, 'docs'), { recursive: true });
    await writeFile(join(repo, 'docs/evidence.txt'), 'stamped\n');
    await writeFile(join(repo, 'docs/steady.txt'), 'stamped too\n');
    await writeFile(join(repo, '.stamps'), 'docs/evidence.txt\ndocs/steady.txt\n');
    await gitIn(repo, 'add', '-A');
    await gitIn(repo, 'commit', '-m', 'two claims, stamped on two files');
    await writeFile(planPath, JSON.stringify(STAMP_PLAN));

    const run = await pleach(['run', planPath, '--repo-root', repo, '--journal', journal], repo);
    expect(run.code).toBe(0);

    const before = await gitIn(repo, 'rev-parse', 'HEAD');
    const gateArgs = [
      'land',
      planPath,
      '--repo-root',
      repo,
      '--journal',
      journal,
      '--land-gate',
      `${LAND_GATE} {base}`,
    ];
    const refused = await pleach(gateArgs, repo);

    expect(refused.code).toBe(1);
    // The reason is printed, not just journaled — the operator is at a
    // terminal — and it names the stamped path the landing moved, not every
    // path the map claims.
    expect(refused.stderr).toContain('stale stamp: docs/evidence.txt');
    expect(refused.stderr).not.toContain('stale stamp: docs/steady.txt');
    const events = await journalEvents(journal);
    const gate = events.find((e) => e.event === 'land-gate-refused');
    // `{base}` became the target tip as it stood BEFORE the merge — the one
    // fact the gate cannot learn from inside the stack.
    expect(gate?.command).toBe(`${LAND_GATE} ${before}`);
    expect(gate?.exitCode).toBe(1);
    expect(String(gate?.outputTail)).toContain('stale stamp: docs/evidence.txt');
    expect(events.some((e) => e.event === 'landed')).toBe(false);
    // Nothing landed and nothing is left behind: tip unmoved, evidence as it
    // was, the stack disposed, the land lock released.
    expect(await gitIn(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(await gitIn(repo, 'show', 'HEAD:docs/evidence.txt')).toBe('stamped');
    expect((await gitIn(repo, 'worktree', 'list')).split('\n')).toHaveLength(1);
    expect(await lockFiles(repo)).toEqual({});

    // The operator answers the gate — the map no longer claims the moved
    // file — and the identical landing goes through.
    await writeFile(join(repo, '.stamps'), 'docs/steady.txt\n');
    await gitIn(repo, 'add', '-A');
    await gitIn(repo, 'commit', '-m', 'the map no longer claims the moved file');

    const landed = await pleach(gateArgs, repo);

    expect(landed.code).toBe(0);
    const out = JSON.parse(landed.stdout.trim()) as { landed: string[]; sha: string };
    expect(out.landed).toEqual(['mover']);
    expect(out.sha).toBe(await gitIn(repo, 'rev-parse', 'HEAD'));
    expect(await gitIn(repo, 'show', 'HEAD:docs/v2/evidence.txt')).toBe('stamped');
    expect((await gitIn(repo, 'worktree', 'list')).split('\n')).toHaveLength(1);
  }, 120000);

  // ledger: D18 — the garden's own gate, when this machine has it. pleach
  // knows nothing about stamps: tend2 is a command like any other.
  test.skipIf(TEND2 === null)(
    'the real tend2 gate refuses the landing that would leave a stamp stale, naming the loop',
    async () => {
      const tend2 = TEND2 as string;
      await mkdir(join(repo, 'garden'), { recursive: true });
      await mkdir(join(repo, 'evidence'), { recursive: true });
      await writeFile(
        join(repo, 'evidence/claim.test.ts'),
        "import { expect, test } from 'bun:test';\ntest('the claim holds', () => { expect(1).toBe(1); });\n",
      );
      await writeFile(
        join(repo, 'garden/stale-claim.tend2.html'),
        [
          '<!doctype html>',
          '<html lang="en">',
          '<meta charset="utf-8">',
          '<title>stale-claim · loop</title>',
          '<body>',
          '<script type="text/markdown" id="loop">',
          '# a claim stamped on evidence this landing changes',
          '',
          '**Goal.** One loop, one check, one cited file — enough map for a gate to read.',
          '',
          '## Tests',
          '- [ ] (code) the cited evidence passes · evidence/claim.test.ts',
          '',
          '## Tried',
          '- 2026-09-10 shaped as the fixture garden for the land gate',
          '</script>',
          '</body>',
          '',
        ].join('\n'),
      );
      await gitIn(repo, 'add', '-A');
      await gitIn(repo, 'commit', '-m', 'a garden with one claim');

      // The stamp is EARNED on the base, by the only thing that can write one.
      const verified = await execLocal(
        [
          tend2,
          'verify',
          'garden/stale-claim.tend2.html',
          '--repo-root',
          repo,
          '--runner',
          'bun test {evidence}',
        ],
        repo,
      );
      expect(verified.exitCode).toBe(0);
      expect(await readFile(join(repo, 'garden/stale-claim.tend2.html'), 'utf8')).toContain(
        '- [x]',
      );
      await gitIn(repo, 'add', '-A');
      await gitIn(repo, 'commit', '-m', 'stamp earned on the base');

      // The node changes the cited evidence so the stamp no longer holds.
      await writeFile(
        planPath,
        JSON.stringify({
          goal: 'a node that breaks the cited evidence',
          source: 'e2e-land-honestly-tend2',
          nodes: [
            {
              id: 'breaker',
              work: {
                command:
                  'bash -lc "printf \\"import { expect, test } from \'bun:test\';\\\\ntest(\'the claim holds\', () => { expect(1).toBe(2); });\\\\n\\" > evidence/claim.test.ts"',
              },
            },
          ],
        }),
      );
      const run = await pleach(['run', planPath, '--repo-root', repo, '--journal', journal], repo);
      expect(run.code).toBe(0);

      const before = await gitIn(repo, 'rev-parse', 'HEAD');
      const refused = await pleach(
        [
          'land',
          planPath,
          '--repo-root',
          repo,
          '--journal',
          journal,
          '--land-gate',
          `${tend2} gate garden --base {base} --runner 'bun test {evidence}'`,
        ],
        repo,
      );

      expect(refused.code).toBe(1);
      // The refusal names the loop whose claim would have gone stale.
      expect(refused.stderr).toContain('stale-claim');
      const gate = (await journalEvents(journal)).find((e) => e.event === 'land-gate-refused');
      expect(gate?.command).toContain(before);
      expect(gate?.command).not.toContain('{base}');
      expect(gate?.exitCode).not.toBe(0);
      // Untouched: the tip, and the stamp on the checkout's own page.
      expect(await gitIn(repo, 'rev-parse', 'HEAD')).toBe(before);
      expect(await gitIn(repo, 'show', 'HEAD:garden/stale-claim.tend2.html')).toContain('- [x]');
      expect((await gitIn(repo, 'worktree', 'list')).split('\n')).toHaveLength(1);
    },
    180000,
  );

  // ledger: D18 — a settled node lands while the run is still gating others.
  test('pleach land --sinks lands one verified node while another process holds the run lock', async () => {
    await writeFile(planPath, JSON.stringify(TWO_NODE_PLAN));
    const run = await pleach(['run', planPath, '--repo-root', repo, '--journal', journal], repo);
    expect(run.code).toBe(0);

    // A live run's lock, held by a real other process for the whole landing.
    const holder = Bun.spawn(['bun', HOLD_LOCK, repo, TWO_NODE_PLAN.source, 'run'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });
    holders.push(holder);
    const reader = holder.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(first.value ?? new Uint8Array())).toContain('held');
    const runLock = Object.keys(await lockFiles(repo));
    expect(runLock).toHaveLength(1);

    const land = await pleach(
      ['land', planPath, '--repo-root', repo, '--journal', journal, '--sinks', 'settled'],
      repo,
    );

    expect(land.code).toBe(0);
    const out = JSON.parse(land.stdout.trim()) as { landed: string[] };
    expect(out.landed).toEqual(['settled']);
    // Exactly the named sink is on the branch; the rest of the run is not.
    const files = (await gitIn(repo, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n');
    expect(files).toContain('settled.txt');
    expect(files).not.toContain('later.txt');
    const start = (await journalEvents(journal)).find((e) => e.event === 'land-start');
    expect(start?.sinks).toEqual(['settled']);
    // The run rode on throughout, and its lock is still its own — the
    // landing never took it, and left no lock of its own behind.
    expect(holder.exitCode).toBeNull();
    expect(await lockFiles(repo)).toEqual({ [runLock[0] as string]: holder.pid });
  }, 120000);

  // ledger: D18 — the landing a run performs is a landing like any other, so
  // the operator's subset is its subset too. Only the assembled face can
  // answer this: `landPlan` has honoured `sinks` since lh.sinks, and the loop
  // tests reach it directly. A flag the face accepts, prints in --help and
  // then never passes on is worse than one it refuses — the landing reports
  // exit 0 over a branch carrying work nobody asked it to publish.
  test('pleach run --land --sinks lands the named sink only, in the same invocation', async () => {
    await writeFile(planPath, JSON.stringify(TWO_NODE_PLAN));

    const out = await pleach(
      ['run', planPath, '--repo-root', repo, '--journal', journal, '--land', '--sinks', 'settled'],
      repo,
    );

    expect(out.code).toBe(0);
    const summary = JSON.parse(out.stdout.trim()) as {
      closed: string[];
      land: { landed: string[]; sha: string };
    };
    // The whole plan still RAN — `--sinks` narrows the landing, not the run.
    expect([...summary.closed].sort()).toEqual(['later', 'settled']);
    expect(summary.land.landed).toEqual(['settled']);
    expect(summary.land.sha).toBe(await gitIn(repo, 'rev-parse', 'HEAD'));
    const files = (await gitIn(repo, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n');
    expect(files).toContain('settled.txt');
    expect(files).not.toContain('later.txt');
    // The journal says what landed, so the subset is auditable after the fact.
    const start = (await journalEvents(journal)).find((e) => e.event === 'land-start');
    expect(start?.sinks).toEqual(['settled']);
    // `later` stays verified and landable — narrowing publishes less, it
    // never discards work.
    expect(await gitIn(repo, 'rev-parse', '--verify', 'node/later')).toMatch(/^[0-9a-f]{40}$/);
  }, 120000);
});
