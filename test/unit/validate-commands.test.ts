/**
 * `pleach validate` refuses what exec would refuse (ledger: D19).
 *
 * pleach execs plan command strings without a shell (SEC1), and the exec path
 * refuses a bare shell operator before running anything (the no-shell guard).
 * A smoke joined by `&&` used to pass validate and be refused at exec after a
 * worker had spent its window, then be retried as if the worker were at fault.
 * The fault is the plan's and is knowable for free: `validatePlan` walks every
 * plan-authored command string (`work.command`, `work.test`, `setup`,
 * `accept.smoke`) with exec's own tokenizer and message. `accept.audit.command`
 * is relayed to the auditor's shell by contract, so it is not checked.
 *
 * `validatePlan` is the one refusal both faces share: `validateReport` (the
 * whole of `pleach validate` after the file read) throws its PlanInvalidError,
 * which the face maps to exit 2 (test/e2e/cli.test.ts), and `runPlan` calls it
 * before the lock is taken.
 */
import { describe, expect, test } from 'bun:test';
import { PlanInvalidError } from '../../src/core/errors.ts';
import { PlanSchema } from '../../src/core/plan.ts';
import { validatePlan } from '../../src/core/validate.ts';
import { validateReport } from '../../src/faces/cli.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { shellGuardRefusal } from '../../src/loop/run-work.ts';
import { makeHarness } from '../loop/harness.ts';

type Field = 'work.command' | 'work.test' | 'setup' | 'accept.smoke';
const FIELDS: Field[] = ['work.command', 'work.test', 'setup', 'accept.smoke'];

function plan(nodes: unknown[]) {
  return PlanSchema.parse({ goal: 'g', source: 's', nodes });
}

// A node whose `field` carries `command`; every other command string is clean.
function nodeWith(id: string, field: Field, command: string, needs: string[] = []) {
  const clean = 'bun test';
  const work =
    field === 'work.command'
      ? { command }
      : field === 'work.test'
        ? {
            test: command,
            phases: [
              { phase: 'red', prompt: 'r' },
              { phase: 'green', prompt: 'g' },
            ],
          }
        : { prompt: 'do it' };
  return {
    id,
    needs,
    work,
    ...(field === 'setup' ? { setup: command } : { setup: clean }),
    accept: { smoke: field === 'accept.smoke' ? command : clean },
  };
}

// What validate throws for `p`, or null when it accepts the plan.
function refusal(p: ReturnType<typeof plan>): PlanInvalidError | null {
  try {
    validatePlan(p);
    return null;
  } catch (err) {
    if (err instanceof PlanInvalidError) return err;
    throw err;
  }
}

// The exec guard's own explanation, without its subject word: the part both
// sites must share verbatim ("contains bare shell operator(s): … bash -lc …").
function guardBody(command: string): string {
  const message = shellGuardRefusal(command);
  expect(message).not.toBeNull();
  return String(message).slice(String(message).indexOf('contains bare shell operator'));
}

describe('validatePlan — bare shell operators in plan commands', () => {
  for (const field of FIELDS) {
    test(`refuses an operator in ${field}, naming the node, the field and exec's message`, () => {
      const command = 'bun test && echo done';
      const err = refusal(plan([nodeWith('n1', field, command)]));

      expect(err).toBeInstanceOf(PlanInvalidError);
      expect(err?.reasons).toHaveLength(1);
      const reason = err?.reasons[0] as string;
      expect(reason).toContain("node 'n1'");
      expect(reason).toContain(field);
      expect(reason).toContain(guardBody(command));
    });

    test(`accepts the escape hatch in ${field}: bash -lc '<command>'`, () => {
      expect(refusal(plan([nodeWith('n1', field, "bash -lc 'bun test && echo done'")]))).toBeNull();
    });
  }

  test('refuses exactly what the exec guard refuses — one tokenizer, one rule', () => {
    const corpus = [
      'bun test && echo done',
      'bun test || true',
      'bun test | tee out.log',
      'bun test ; echo after',
      'bun test > out.log',
      'bun test >> out.log',
      'wc -l < file.txt',
      'bun test 2>&1',
      "bash -lc 'bun test && echo done'",
      'bash -lc "make > build.log"',
      "grep 'a&&b' file.txt",
      'grep a\\|b file.txt',
      'node --flag=>x run.mjs',
      'bun test',
    ];
    for (const command of corpus) {
      const refusedAtExec = shellGuardRefusal(command) !== null;
      for (const field of FIELDS) {
        const refusedAtValidate = refusal(plan([nodeWith('n', field, command)])) !== null;
        expect({ command, field, refused: refusedAtValidate }).toEqual({
          command,
          field,
          refused: refusedAtExec,
        });
      }
    }
  });

  test('names every offending node and field, in plan order, and never a clean one', () => {
    const p = plan([
      { id: 'a', work: { command: 'make && make install' }, accept: { smoke: 'bun test | tee x' } },
      { id: 'clean', needs: ['a'], work: { prompt: 'do it' }, accept: { smoke: 'bun test' } },
      { id: 'b', needs: ['clean'], setup: 'bun install ; bun run build', work: { prompt: 'p' } },
    ]);
    const reasons = refusal(p)?.reasons ?? [];

    expect(reasons).toHaveLength(3);
    expect(reasons[0]).toContain("node 'a'");
    expect(reasons[0]).toContain('work.command');
    expect(reasons[1]).toContain("node 'a'");
    expect(reasons[1]).toContain('accept.smoke');
    expect(reasons[2]).toContain("node 'b'");
    expect(reasons[2]).toContain('setup');
    expect(reasons.join('\n')).not.toContain("node 'clean'");
  });

  test('joins the structural reasons in one refusal', () => {
    const p = plan([{ id: 'a', needs: ['ghost'], work: { command: 'make && make install' } }]);
    const reasons = refusal(p)?.reasons ?? [];

    expect(reasons.some((r) => r.includes("unknown id: 'ghost'"))).toBe(true);
    expect(reasons.some((r) => r.includes("node 'a'") && r.includes('work.command'))).toBe(true);
  });

  test('an unparseable command is a plan refusal naming the node and field, not a raw throw', () => {
    // exec would throw on this quoting; validate names it as the plan's fault.
    const err = refusal(plan([nodeWith('q', 'accept.smoke', "bun test 'unterminated")]));

    expect(err).toBeInstanceOf(PlanInvalidError);
    expect(err?.reasons).toHaveLength(1);
    expect(err?.reasons[0]).toContain("node 'q'");
    expect(err?.reasons[0]).toContain('accept.smoke');
  });

  test('accept.audit.command is relayed to the auditor shell and is not checked', () => {
    const p = plan([
      {
        id: 'a',
        work: { prompt: 'do it' },
        accept: { audit: { command: 'tend audit x && echo ok', provider: 'codex' } },
      },
    ]);
    expect(refusal(p)).toBeNull();
  });
});

describe('pleach validate — the report', () => {
  test('a plan with an operator in its smoke throws the refusal the face maps to exit 2', () => {
    const p = plan([
      { id: 'smoked', work: { prompt: 'p' }, accept: { smoke: 'bun i && bun test' } },
    ]);

    let thrown: unknown = null;
    try {
      validateReport(p);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PlanInvalidError);
    const reasons = (thrown as PlanInvalidError).reasons;
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("node 'smoked'");
    expect(reasons[0]).toContain('accept.smoke');
    expect(reasons[0]).toContain('&&');
  });

  test("a clean plan's JSON line is unchanged, escape hatch and audit command included", () => {
    const p = plan([
      { id: 'a', setup: 'bun install', work: { command: "bash -lc 'make && make install'" } },
      {
        id: 'b',
        needs: ['a'],
        work: { prompt: 'p' },
        accept: {
          smoke: 'bun test',
          audit: { command: 'tend audit x && echo ok', provider: 'codex' },
        },
      },
    ]);
    const report = validateReport(p);

    expect(report.code).toBe(0);
    expect(report.stderr).toBe('');
    expect(JSON.parse(report.stdout)).toEqual({
      valid: true,
      order: ['a', 'b'],
      waves: [['a'], ['b']],
      nodes: [
        { id: 'a', work: 'command', gates: ['setup'] },
        { id: 'b', work: 'prompt', gates: ['smoke', 'audit:codex'] },
      ],
      warnings: [],
    });
  });
});

describe('pleach run — refuses before the lock', () => {
  test('a plan with an operator in a setup is refused before lock.acquire, isolate or spawn', async () => {
    const h = makeHarness();
    const p = plan([{ id: 's', setup: 'bun install && bun run build', work: { prompt: 'p' } }]);

    const err = await runPlan(p, h.deps, { repoRoot: '/r' }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(PlanInvalidError);
    expect((err as PlanInvalidError).reasons.join('\n')).toContain("node 's'");
    expect(h.log.first('lock.acquire')).toBe(-1);
    expect(h.log.first('isolate')).toBe(-1);
    expect(h.log.first('spawn:build')).toBe(-1);
    expect(h.log.first('exec')).toBe(-1);
  });
});
