// ledger: D19 — a gate that cannot run at all is the plan's fault or the
// environment's, never the work's. The no-shell guard refuses a command before
// anything is exec'd (exit -1, the escape hatch named); the exec seam answers a
// spawn that never happened — a missing binary, a cwd that is not there — with
// exit 127 and the spawn error as output. Neither ran a command, so there is no
// red for a worker to fix and nothing a flaky retry could change: re-running
// the gate spends time, and re-prompting the worker spends its window on a
// fault it cannot touch (jahala/pleach#69). The node settles on the attempt the
// fault was found in, `gate.ran` naming the command and `detail` naming whose
// fault it is. A gate that ran and exited non-zero is the work's red and keeps
// today's retry-with-evidence.
import { describe, expect, test } from 'bun:test';
import { type Node, PlanSchema } from '../../src/core/plan.ts';
import { runNode } from '../../src/loop/run-node.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, type HarnessOpts, makeHarness, makeNode } from './harness.ts';

const DEF = 60_000;
const MAX = 3; // room for a second attempt, so its absence is the claim
const POLICY: Node['policy'] = { maxAttempts: MAX, onDead: 'resume', reauditWhen: ['compacted'] };

// The binary the environment does not have, and what the exec seam answers for
// it — the text Bun.spawn throws, verbatim (src/seams/exec.ts resolves it as 127).
const MISSING = 'pleach-no-such-binary';
const SPAWN_ERROR = `Executable not found in $PATH: "${MISSING}"`;
const RETRY_MARKER = 'previous attempt failed';

type Gate = 'setup' | 'smoke' | 'command' | 'red' | 'green';
type Fault = 'plan' | 'environment';

// The command each fault puts in the gate: a bare shell operator the guard
// refuses before exec, or a binary the environment cannot spawn.
function commandFor(fault: Fault): string {
  return fault === 'plan' ? `${MISSING} --check && echo ok` : `${MISSING} --check`;
}

function nodeFor(gate: Gate, command: string): Node {
  const tdd = (test: string) => ({
    test,
    phases: [
      { phase: 'red' as const, prompt: 'write the failing test' },
      { phase: 'impl' as const, prompt: 'make it pass' },
      { phase: 'green' as const, prompt: 'run the suite' },
    ],
  });
  switch (gate) {
    case 'setup':
      return makeNode({ id: 'n', setup: command, policy: POLICY });
    case 'smoke':
      return makeNode({ id: 'n', accept: { smoke: command }, policy: POLICY });
    case 'command':
      return makeNode({ id: 'n', work: { command }, policy: POLICY });
    case 'red':
    case 'green':
      return makeNode({ id: 'n', work: tdd(command), policy: POLICY });
  }
}

// Build workers the node spawns before the gate is reached: setup runs before
// any worker, a {command} node never has one.
const SPAWNS_BEFORE: Record<Gate, number> = { setup: 0, smoke: 1, command: 0, red: 1, green: 1 };

function execsOf(h: Harness, binary: string): number {
  return h.log.of('exec').filter((e) => e.detail?.startsWith(binary)).length;
}

function reprompts(h: Harness): number {
  return h.log.of('send').filter((e) => e.detail?.includes(RETRY_MARKER)).length;
}

// The exec seam as the harness models it: the missing binary cannot spawn. For
// the green gate the suite runs once first — the red phase's own run, a real
// red — and the runner is gone by the time green asks for it.
function environmentFor(gate: Gate): HarnessOpts['execScript'] {
  let runs = 0;
  return (argv) => {
    if (argv[0] !== MISSING) return { output: '', exitCode: 0 };
    runs += 1;
    if (gate === 'green' && runs === 1)
      return { output: 'FAIL widget: not implemented', exitCode: 1 };
    return { output: SPAWN_ERROR, stdout: '', exitCode: 127 };
  };
}

const GATES: Gate[] = ['setup', 'smoke', 'command', 'red', 'green'];

describe('a gate that cannot run settles the node once, naming whose fault (D19)', () => {
  for (const gate of GATES) {
    for (const fault of ['plan', 'environment'] as const) {
      // The guard answers from the command string alone, and red and green run
      // the same `work.test` — a guard refusal of green is the red refusal.
      if (gate === 'green' && fault === 'plan') continue;

      test(`${gate}: the ${fault}'s fault → failed on attempt 1, no second attempt, no re-prompt`, async () => {
        const command = commandFor(fault);
        const h = makeHarness(fault === 'environment' ? { execScript: environmentFor(gate) } : {});

        const r = await runNode(nodeFor(gate, command), ['base'], h.deps, {
          defaultTimeoutMs: DEF,
        });

        expect(r.verdict.status).toBe('failed');
        expect(r.verdict.attempts).toBe(1);
        expect(r.verdict.evidence.gate).toEqual({
          ran: command,
          exitCode: fault === 'plan' ? -1 : 127,
        });

        // The fault is named, with what the guard or the seam said about it.
        const detail = r.verdictDetail ?? '';
        if (fault === 'plan') {
          expect(detail).toMatch(/plan/);
          expect(detail).toContain('bash -lc');
        } else {
          expect(detail).toMatch(/environment/);
          expect(detail).toContain(SPAWN_ERROR);
        }

        // One attempt: one tree, the workers that ran before the gate and no
        // more, and nobody prompted to fix what no worker can.
        expect(h.log.count('isolate', 'n')).toBe(1);
        expect(h.log.count('spawn:build', 'n')).toBe(SPAWNS_BEFORE[gate]);
        expect(reprompts(h)).toBe(0);

        // Nothing to flake: the gate-only retry does not re-run it. The guard
        // execs nothing; the seam was asked once for the gate that could not
        // spawn (green's once more for the red phase's real run).
        expect(h.journal.some((e) => e.event === 'gate-retry')).toBe(false);
        expect(execsOf(h, MISSING)).toBe(fault === 'plan' ? 0 : gate === 'green' ? 2 : 1);

        // A red that never ran is no red: nothing is sealed as the failing test.
        // Green's red phase ran and failed for real, so its seal stands.
        const seals = h.journal.filter((e) => e.event === 'phase-commit').length;
        expect(seals).toBe(gate === 'green' ? 1 : 0);

        // The tree goes back for quarantine like any failed node's.
        expect(r.iso).toBeDefined();
      });
    }
  }
});

describe('a gate that ran and failed keeps the retry (D10, A3)', () => {
  const RED = { output: 'FAIL: 1 test failed', exitCode: 1 };

  for (const gate of ['setup', 'smoke', 'command'] as const) {
    test(`${gate}: exit 1 is the work's red → every attempt spent, no fault named`, async () => {
      const command = `${MISSING} --check`;
      const h = makeHarness({
        execScript: (argv) => (argv[0] === MISSING ? RED : { output: '', exitCode: 0 }),
      });

      const r = await runNode(nodeFor(gate, command), ['base'], h.deps, { defaultTimeoutMs: DEF });

      expect(r.verdict.status).toBe('failed');
      expect(r.verdict.attempts).toBe(MAX);
      expect(r.verdict.evidence.gate).toEqual({ ran: command, exitCode: 1 });
      expect(r.verdictDetail).toBeUndefined();
      // setup and smoke get the flaky retry on every attempt; command work never did.
      const perAttempt = gate === 'command' ? 1 : 2;
      expect(execsOf(h, MISSING)).toBe(MAX * perAttempt);
      expect(h.journal.some((e) => e.event === 'gate-retry')).toBe(gate !== 'command');
    });
  }

  test('smoke: the worker is re-prompted with the red as evidence', async () => {
    const h = makeHarness({
      execScript: (argv) => (argv[0] === MISSING ? RED : { output: '', exitCode: 0 }),
    });

    await runNode(nodeFor('smoke', `${MISSING} --check`), ['base'], h.deps, {
      defaultTimeoutMs: DEF,
    });

    expect(h.log.count('spawn:build', 'n')).toBe(MAX);
    expect(reprompts(h)).toBe(MAX - 1);
    const reprompt = h.log.of('send').find((e) => e.detail?.includes(RETRY_MARKER));
    expect(reprompt?.detail).toContain('FAIL: 1 test failed');
  });
});

describe('through the run: the fault reaches the journal and the tree is kept (D19)', () => {
  test('a smoke naming a missing binary fails the node once, the verdict line naming the environment', async () => {
    const h = makeHarness({ execScript: environmentFor('smoke') });
    const plan = PlanSchema.parse({
      goal: 'g',
      source: 's',
      nodes: [
        {
          id: 'x',
          work: { prompt: 'build x' },
          accept: { smoke: `${MISSING} --check` },
          policy: { maxAttempts: MAX },
        },
      ],
    });

    const summary = await runPlan(plan, h.deps, { repoRoot: '/r', pleachVersion: '0.0.1-test' });

    expect(summary.failed).toEqual(['x']);
    expect(summary.quarantined).toEqual(['x']);
    expect(h.log.count('spawn:build', 'x')).toBe(1);
    const line = h.journal.find((e) => e.event === 'verdict' && e.node === 'x');
    expect(line?.attempts).toBe(1);
    expect((line?.gate as Record<string, unknown>)?.ran).toBe(`${MISSING} --check`);
    expect((line?.gate as Record<string, unknown>)?.exitCode).toBe(127);
    expect(String(line?.detail)).toMatch(/environment/);
    expect(String(line?.detail)).toContain(SPAWN_ERROR);
  });
});
