/**
 * E2E: the red phase is its own commit (ledger D13) — through the real CLI,
 * real git, the scripted runner and REAL gate execution.
 *
 * The loop tests prove the seal against the in-memory seams; this is the first
 * proof against the substrate `weeder bite` actually reads. What it demands of
 * a closed phased node is the whole of D13: `node/<id>` reads base → red →
 * verified, the red commit is a checkout-able failing-test state (the test
 * present, the seed untouched, the command genuinely non-zero), the verified
 * commit sits on top of it and passes, and the journal names what was sealed.
 *
 * Two layouts, because the seal's raw material is git's own status output and
 * that output changes shape with the tree: the test beside the source, and the
 * test in a directory git has never seen. The guarantee may not.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRepo, execLocal, gitIn } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const CONFIG = join(import.meta.dir, '../fixtures/phases-scripted.config.ts');

// The seed: add() exists but is WRONG — a genuinely failing test can exist.
const CALC_SEED = `export function add(a: number, b: number): number {
  return 0;
}
`;

interface Layout {
  /** How the test names the case. */
  readonly name: string;
  /** The scripted persona whose red/impl/green prompts drive it. */
  readonly persona: 'HONEST' | 'NESTED';
  /** Where the broken seed lives — committed before the run. */
  readonly seedPath: string;
  /** Where the red phase writes its failing test — NOT committed. */
  readonly specPath: string;
  /** The node's `work.test`, run for real by the red and green gates. */
  readonly testCmd: string;
}

const LAYOUTS: readonly Layout[] = [
  {
    name: 'the test beside the source',
    persona: 'HONEST',
    seedPath: 'calc.ts',
    specPath: 'calc.test.ts',
    testCmd: 'bun test calc.test.ts',
  },
  {
    name: 'the test in a directory git has never seen',
    persona: 'NESTED',
    seedPath: 'src/calc.ts',
    specPath: 'test/calc.test.ts',
    testCmd: 'bun test test/calc.test.ts',
  },
];

function planFor(layout: Layout) {
  return {
    goal: 'phase-commit proof',
    source: `e2e-phase-commit-${layout.persona}`,
    nodes: [
      {
        id: 'calc',
        work: {
          test: layout.testCmd,
          phases: [
            { phase: 'red', prompt: `${layout.persona}-RED: write a failing test for add()` },
            { phase: 'impl', prompt: `${layout.persona}-IMPL: make the test pass` },
            { phase: 'green', prompt: `${layout.persona}-GREEN: confirm the suite` },
          ],
        },
        accept: { smoke: layout.testCmd },
        policy: { maxAttempts: 1 },
      },
    ],
  };
}

async function pleachRun(repo: string, plan: unknown): Promise<{ code: number; stdout: string }> {
  const planPath = join(repo, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  const proc = Bun.spawn(['bun', MAIN, 'run', planPath, '--config', CONFIG, '--repo-root', repo], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: repo,
    env: process.env,
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code: code ?? 1, stdout };
}

// Check a commit's TREE out for real and run the node's test command in it —
// what `weeder bite` does, and the only honest way to ask whether a sealed
// state is the failing one it claims to be.
async function testAt(repo: string, sha: string, testCmd: string): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), 'pleach-probe-'));
  const probe = join(dir, 'wt');
  await gitIn(repo, 'worktree', 'add', '--detach', probe, sha);
  try {
    return (await execLocal(testCmd.split(' '), probe)).exitCode;
  } finally {
    await gitIn(repo, 'worktree', 'remove', '--force', probe);
    await rm(dir, { recursive: true, force: true });
  }
}

describe('phase-commit — base → red → verified in real git', () => {
  let repo = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();
  let seed = '';

  afterEach(async () => {
    await cleanup();
  });

  for (const layout of LAYOUTS) {
    describe(layout.name, () => {
      beforeEach(async () => {
        const r = await createRepo();
        repo = r.path;
        cleanup = r.cleanup;
        await mkdir(dirname(join(repo, layout.seedPath)), { recursive: true });
        await writeFile(join(repo, layout.seedPath), CALC_SEED);
        await gitIn(repo, 'add', layout.seedPath);
        await gitIn(repo, 'commit', '-m', 'seed: broken add()');
        seed = await gitIn(repo, 'rev-parse', 'HEAD');
      });

      // ledger: D13
      test('node/calc is base → red → verified and the journal names the seal', async () => {
        const r = await pleachRun(repo, planFor(layout));
        const summary = JSON.parse(r.stdout.trim()) as { closed: string[]; failed: string[] };
        expect(summary.failed).toEqual([]);
        expect(summary.closed).toEqual(['calc']);
        expect(r.code).toBe(0);

        // Exactly two commits above the seed: the red seal and the verified close.
        const above = (await gitIn(repo, 'rev-list', `${seed}..node/calc`))
          .split('\n')
          .filter(Boolean);
        expect(above.length).toBe(2);
        const [tip, red] = above as [string, string];

        // The red commit is the seal: named, trailered, and the parent of the tip.
        expect(await gitIn(repo, 'show', '-s', '--format=%s', red)).toBe('pleach: calc red phase');
        // Git's own trailer parser, not a substring — it is what `weeder bite`
        // reads, and a trailer git cannot see is a trailer nobody can query.
        const trailer = '--format=%(trailers:key=pleach-phase,valueonly)';
        expect(await gitIn(repo, 'show', '-s', trailer, red)).toBe('red');
        expect(await gitIn(repo, 'rev-parse', `${tip}^`)).toBe(red);

        // Its tree is the failing-test state: the test written, the seed untouched.
        expect(await gitIn(repo, 'show', `${red}:${layout.specPath}`)).toContain('toBe(5)');
        expect(await gitIn(repo, 'show', `${red}:${layout.seedPath}`)).toBe(CALC_SEED.trimEnd());
        expect(await testAt(repo, red, layout.testCmd)).not.toBe(0);

        // The tip is the verified state: it passes, and carries the receipt trailer.
        expect(await testAt(repo, tip, layout.testCmd)).toBe(0);
        expect(await gitIn(repo, 'show', '-s', '--format=%B', tip)).toContain('receipt-sha256: ');

        // One phase-commit event, naming the commit that was actually made and
        // the files that are actually in it. `files` is the record of what the
        // seal staged — what `weeder check` judges the impl against and what
        // the receipt counts — so every path in it must be a blob in the red
        // commit, not the directory git happened to collapse it into.
        const journal = await readFile(join(repo, '.git', 'pleach', 'journal.jsonl'), 'utf8');
        const seals = journal
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .filter((e) => e.event === 'phase-commit' && e.node === 'calc');
        expect(seals.length).toBe(1);
        const seal = seals[0] as { phase: string; sha: string; files: string[] };
        expect(seal.phase).toBe('red');
        expect(seal.sha).toBe(red);
        const sealedTree = (await gitIn(repo, 'ls-tree', '-r', '--name-only', red)).split('\n');
        expect(seal.files.filter((f) => !sealedTree.includes(f))).toEqual([]);
        expect(seal.files).toContain(layout.specPath);
      }, 90_000);
    });
  }
});
