import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunnerSeam } from 'pleach';
import { gitLedger } from 'pleach/adapters/git';
import { scriptedAuditResult, scriptedRunner } from 'pleach/adapters/scripted';
import type { PleachConfig } from 'pleach/config';

// The cast for test/e2e/nothing-is-lost.test.ts (ledger D17) — the whole line
// in one config. Two nodes meet the two ways a run drops what a worker made:
//
//  feature — a {test, phases} builder whose turn is cut mid-implementation.
//  With PLEACH_TEST_HALT naming a sentinel path, the impl phase's worker
//  writes what it had got to, touches that sentinel, and then ends its wait
//  the way umbel's adapter ends an interrupted one — reason 'aborted', with
//  the message it had already given. The re-run meets the same cast unarmed,
//  so what it does is what a resumed build does.
//
//  report — a builder whose auditor hands back prose instead of the fenced
//  block. PLEACH_TEST_AUDIT_RELAY picks what the codex auditor relays on THIS
//  invocation, so the run and the `pleach audit` that re-adjudicates it meet
//  different auditors in the same repo. The builder stamps the relay it built
//  under into report.txt: only a re-spawned builder can change that stamp.

type Relay = 'garbage' | 'pass' | 'fail';

function relay(): Relay {
  const value = process.env.PLEACH_TEST_AUDIT_RELAY;
  return value === 'pass' || value === 'fail' ? value : 'garbage';
}

// A plausible auditor reply with no fenced block anywhere in it.
const AUDITOR_PROSE = [
  'I ran the audit command and read what it printed.',
  '',
  'It all looks right to me — I would call this one verified.',
].join('\n');

const AUDITOR: Record<Relay, string> = {
  garbage: AUDITOR_PROSE,
  pass: scriptedAuditResult([{ check: 'report', verdict: 'pass' }]),
  fail: scriptedAuditResult([
    { check: 'report', verdict: 'fail', reasons: ['report.txt says nothing'] },
  ]),
};

// The red phase's work: a genuinely failing test over the seeded greet().
const FAILING_TEST = `import { expect, test } from 'bun:test';
import { greet } from './feature.ts';

test('greet names who it greets', () => {
  expect(greet('ada')).toBe('hello, ada');
});
`;

/** The implementation the finished turn writes — what a verified close carries. */
export const GREET_DONE = `export function greet(name: string): string {
  return \`hello, \${name}\`;
}
`;

// What the interrupted worker had already written when its turn ended: the
// implementation half-done, still failing the test it wrote a moment earlier.
// This is the work a halt used to throw away.
export const GREET_HALF_WRITTEN = `export function greet(_name: string): string {
  return 'hello, ';
}
`;

/** The hand-back of the turn that was cut — kept beside the aborted close. */
export const INTERRUPTED_HANDBACK = [
  'Wrote the failing test for greet() and watched it go red.',
  'Was part-way through the implementation when the turn ended.',
].join('\n');

/** The hand-back of the turn that finished — kept beside the verified close. */
export const GREEN_HANDBACK = 'greet() implemented; the suite is green.';

/** The phase prompt whose wait the halt interrupts. */
const HALT_AT = 'IMPL:';

function interrupted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function halting(inner: RunnerSeam, sentinel: string): RunnerSeam {
  return {
    spawnWorker: async (spec) => {
      const worker = await inner.spawnWorker(spec);
      let sent = '';
      return {
        send: async (text) => {
          sent = text;
          await worker.send(text);
        },
        wait: async (opts) => {
          const signal = opts?.signal;
          // Only the armed phase halts, and only while the conductor holds a
          // teardown signal to be interrupted by.
          if (!sent.includes(HALT_AT) || signal === undefined) return worker.wait(opts);
          await writeFile(join(spec.cwd, 'feature.ts'), GREET_HALF_WRITTEN);
          await writeFile(sentinel, `${spec.cwd}\n`);
          await interrupted(signal);
          return {
            finalMessage: INTERRUPTED_HANDBACK,
            filesTouched: ['feature.ts'],
            reason: 'aborted',
            telemetry: {},
          };
        },
        kill: () => worker.kill(),
      };
    },
  };
}

const scripted = scriptedRunner([
  { provider: 'codex', message: AUDITOR[relay()] },
  {
    prompt: 'RED:',
    files: { 'feature.test.ts': FAILING_TEST },
    message: 'wrote the failing test for greet()',
  },
  { prompt: 'IMPL:', files: { 'feature.ts': GREET_DONE }, message: 'implemented greet()' },
  { prompt: 'GREEN:', message: GREEN_HANDBACK },
  {
    prompt: 'REPORT:',
    files: { 'report.txt': `report (relay=${relay()})\n` },
    message: 'wrote report.txt',
  },
]);

const halt = process.env.PLEACH_TEST_HALT;

export default {
  runner: halt === undefined ? scripted : halting(scripted, halt),
  ledger: gitLedger(),
} satisfies PleachConfig;
