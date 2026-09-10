/**
 * E2E: a fault in the plan is refused before a worker costs anything (ledger
 * D19), through the real CLI over real git.
 *
 * Command-only plans, like quarantine.test.ts: a {command} node needs no
 * runner, so nothing here is faked and it runs everywhere CI does. Three
 * questions only the assembled face can answer:
 *
 *   · `pleach validate` refuses a smoke joined by a bare `&&` with exit 2,
 *     naming the node and the field, and `pleach run` refuses the same plan
 *     before it writes a journal, takes a lock, or isolates a tree.
 *   · `pleach run` on a smoke naming a binary that is not there settles the
 *     node on its first attempt: the work ran once, the journal holds one
 *     node-start, no gate-retry, and one verdict whose detail names the
 *     environment, which the terminal narrates too; the receipt seals the
 *     quarantine.
 *   · `pleach schema` tells a planner what the validator accepts: the fields
 *     zod defaults are absent from `required`, and that plan's minimal sibling
 *     — every defaulted field left out — conforms key for key.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRepo, execLocal, gitIn } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

// A binary no machine has; the flag makes it read like a real gate.
const MISSING_SMOKE = 'definitely-not-a-binary-xyz --flag';

// The work appends a line per run, so the quarantined tree counts attempts
// independently of what the journal says about them.
const WORK = 'bash -lc "echo ran >> runs.txt"';

const AMPERSAND_PLAN = {
  goal: 'a smoke joined by a bare && is the plan`s fault',
  source: 'e2e-fail-before-spend-validate',
  nodes: [{ id: 'joined', work: { command: WORK }, accept: { smoke: 'bun test && bun run lint' } }],
};

// No policy: the default maxAttempts (2) is what a retry would spend, so one
// attempt is the loop's decision, not the plan's cap.
const MISSING_BINARY_PLAN = {
  goal: 'a smoke naming a missing binary is the environment`s fault',
  source: 'e2e-fail-before-spend-run',
  nodes: [{ id: 'fragile', work: { command: WORK }, accept: { smoke: MISSING_SMOKE } }],
};

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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function journalEvents(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// The keywords `pleach schema` emits for the plan's objects.
type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
};

// Every key of `value` checked against the schema: a required key missing, or
// a key the schema does not know where it forbids extras. [] = the keys agree.
function keyFaults(value: unknown, s: JsonSchema, path: string): string[] {
  if (s.anyOf) {
    const fits = s.anyOf.some((branch) => keyFaults(value, branch, path).length === 0);
    return fits ? [] : [`${path}: fits no anyOf branch`];
  }
  if (Array.isArray(value)) {
    const items = s.items;
    return items ? value.flatMap((v, i) => keyFaults(v, items, `${path}[${i}]`)) : [];
  }
  if (typeof value !== 'object' || value === null) return [];
  const obj = value as Record<string, unknown>;
  const missing = (s.required ?? [])
    .filter((k) => !(k in obj))
    .map((k) => `${path}.${k}: required`);
  const present = Object.entries(obj).flatMap(([k, v]) => {
    const sub = s.properties?.[k];
    if (sub) return keyFaults(v, sub, `${path}.${k}`);
    return s.additionalProperties === false ? [`${path}.${k}: not allowed`] : [];
  });
  return [...missing, ...present];
}

describe('fail before spend — through the real CLI', () => {
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

  // ledger: D19 — #64: validate accepted what exec refused, a finished build later.
  test('validate refuses a bare && in a smoke with exit 2; run refuses it before anything runs', async () => {
    const planPath = join(repo, 'plan.json');
    const journal = join(repo, 'journal.jsonl');
    await writeFile(planPath, JSON.stringify(AMPERSAND_PLAN));

    const validate = await pleach(['validate', planPath], repo);
    expect(validate.code).toBe(2);
    expect(validate.stdout).toBe('');
    expect(validate.stderr).toContain("node 'joined'");
    expect(validate.stderr).toContain('accept.smoke');
    expect(validate.stderr).toContain('&&');
    // The escape hatch exec names is the one validate names.
    expect(validate.stderr).toContain('bash -lc');

    const run = await pleach(['run', planPath, '--repo-root', repo, '--journal', journal], repo);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("node 'joined'");
    // Nothing ran: no journal, no lock, no tree, no branch, no work.
    expect(await exists(journal)).toBe(false);
    expect((await readdir(join(repo, '.git'))).filter((f) => f.startsWith('pleach-'))).toEqual([]);
    expect((await gitIn(repo, 'worktree', 'list')).split('\n').length).toBe(1);
    const refs = await execLocal(['git', '-C', repo, 'for-each-ref', 'refs/heads/'], repo);
    expect(refs.output).not.toContain('node/');
    expect(refs.output).not.toContain('quarantine/');
    expect(await exists(join(repo, 'runs.txt'))).toBe(false);
  }, 60_000);

  // ledger: D19 — #69: a gate that could not exec was retried as the work's red.
  test('run on a smoke naming a missing binary fails the node once, naming the environment', async () => {
    const planPath = join(repo, 'plan.json');
    const journal = join(repo, 'journal.jsonl');
    await writeFile(planPath, JSON.stringify(MISSING_BINARY_PLAN));

    // The plan is well-formed: the fault is the machine's, so validate passes it.
    expect((await pleach(['validate', planPath], repo)).code).toBe(0);

    const run = await pleach(['run', planPath, '--repo-root', repo, '--journal', journal], repo);
    expect(run.code).toBe(1);
    const summary = JSON.parse(run.stdout.trim()) as { failed: string[]; quarantined: string[] };
    expect(summary.failed).toEqual(['fragile']);
    expect(summary.quarantined).toEqual(['fragile']);

    const events = (await journalEvents(journal)).filter((e) => e.node === 'fragile');
    const kinds = events.map((e) => e.event);
    expect(kinds.filter((k) => k === 'node-start')).toHaveLength(1);
    expect(kinds).not.toContain('gate-retry');
    const verdicts = events.filter((e) => e.event === 'verdict');
    expect(verdicts).toHaveLength(1);
    const verdict = verdicts[0] as {
      status: string;
      attempts: number;
      spawned: boolean;
      detail?: string;
      gate?: { ran: string; exitCode: number; outputTail?: string };
    };
    expect(verdict.status).toBe('failed');
    expect(verdict.attempts).toBe(1);
    // A command node: no worker ran on the first attempt, and none on a second.
    expect(verdict.spawned).toBe(false);
    expect(verdict.gate?.ran).toBe(MISSING_SMOKE);
    expect(verdict.gate?.exitCode).toBe(127);
    expect(verdict.detail).toContain('environment');
    expect(verdict.detail).toContain('definitely-not-a-binary-xyz');
    // The operator who reads only the terminal is told the same: a fault named
    // in a file nobody opened is not named (the narration renders the journal).
    expect(run.stderr).toContain(verdict.detail ?? '(verdict carried no detail)');

    // The tree says the same as the journal: the work ran exactly once.
    expect(await gitIn(repo, 'show', 'quarantine/fragile:runs.txt')).toBe('ran');
    const nodeRefs = await execLocal(['git', '-C', repo, 'for-each-ref', 'refs/heads/node/'], repo);
    expect(nodeRefs.output.trim()).toBe('');
    expect((await gitIn(repo, 'worktree', 'list')).split('\n').length).toBe(1);

    // The receipt seals the quarantine with the one attempt and the gate that never ran.
    const receipt = await pleach(['receipt', 'fragile', '--repo-root', repo], repo);
    expect(receipt.code).toBe(0);
    expect((JSON.parse(receipt.stdout.trim()) as { derived: string }).derived).toBe('quarantined');
    const sealed = JSON.parse(
      await readFile(join(repo, '.git', 'pleach', 'receipts', 'fragile.json'), 'utf8'),
    ) as { facts: { attempts: number; gates: { gate: string; exitCode: number }[] } };
    expect(sealed.facts.attempts).toBe(1);
    expect(sealed.facts.gates).toContainEqual(
      expect.objectContaining({ gate: 'smoke', exitCode: 127 }),
    );
  }, 60_000);

  // ledger: D19 — #68: the schema told a planner defaulted fields were required.
  test('schema leaves defaulted fields out of required, and the minimal sibling plan conforms', async () => {
    const out = await pleach(['schema'], repo);
    expect(out.code).toBe(0);
    const schema = JSON.parse(out.stdout) as JsonSchema;
    const nodeSchema = schema.properties?.nodes?.items;
    const policySchema = nodeSchema?.properties?.policy;
    expect(nodeSchema).toBeDefined();
    expect(policySchema).toBeDefined();
    for (const k of ['worker', 'needs', 'accept', 'policy', 'closes']) {
      expect(nodeSchema?.properties).toHaveProperty(k);
      expect(nodeSchema?.required ?? []).not.toContain(k);
    }
    for (const k of ['maxAttempts', 'onDead', 'reauditWhen']) {
      expect(policySchema?.properties).toHaveProperty(k);
      expect(policySchema?.required ?? []).not.toContain(k);
    }

    // The run plan above, and its minimal sibling: only what the validator
    // cannot default. Both pass validate and both conform to the schema.
    const [node] = MISSING_BINARY_PLAN.nodes;
    const sibling = { ...MISSING_BINARY_PLAN, nodes: [{ id: node?.id, work: node?.work }] };
    for (const [name, plan] of [
      ['plan', MISSING_BINARY_PLAN],
      ['sibling', sibling],
    ] as const) {
      const planPath = join(repo, `${name}.json`);
      await writeFile(planPath, JSON.stringify(plan));
      expect((await pleach(['validate', planPath], repo)).code).toBe(0);
      expect(keyFaults(plan, schema, 'plan')).toEqual([]);
    }

    // The walk discriminates: a node without its work is refused by both.
    const noWork = { ...MISSING_BINARY_PLAN, nodes: [{ id: node?.id }] };
    expect(keyFaults(noWork, schema, 'plan')).toEqual(['plan.nodes[0].work: required']);
  }, 60_000);
});
