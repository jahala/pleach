/**
 * Unit: the umbel adapter reads the wait's reason whatever the exit code
 * (ledger D23, jahala/pleach#120).
 *
 * The rule is the runner seam's, contracts/runner.md on jahala/plotplot, section
 * "A non-zero exit with a reason is a result": `umbel wait` exits with the code
 * in the contract's table and still prints its JSON result on stdout; a
 * conductor reads the reason from that JSON whatever the exit code, and treats
 * the call as a seam failure only when there is no parsable reason.
 *
 * On 2026-09-18 this adapter threw `wait exited N` on any non-zero exit before
 * it parsed the JSON, so a timeout (124), a provider error (122) and a stalled
 * auditor never reached classify, and jahala/quadrat lost four verified trees
 * in one night.
 *
 * The ExecFn here is a real, observable script of umbel's verbs (not a mock of
 * the adapter): the subject is what the adapter makes of a wait's exit code
 * and stdout.
 */
import { describe, expect, test } from 'bun:test';
import { createUmbelSeam } from '../../src/adapters/umbel.ts';
import { WorkerSeamError } from '../../src/core/errors.ts';
import type { ExecFn } from '../../src/loop/deps.ts';

// umbel as the adapter meets it: spawn echoes the name, status finds the
// session, send answers its baseline, and `wait` answers what the case scripts.
function umbelWhoseWaitAnswers(wait: { exitCode: number; output: string }): ExecFn {
  return async (argv) => {
    const a = [...argv];
    const verb = a[1];
    if (verb === 'spawn') {
      const name = a[a.indexOf('--name') + 1] ?? '';
      const output = `spawned: ${name}\n`;
      return { exitCode: 0, output, stdout: output };
    }
    if (verb === 'send') {
      const output = '{"sinceMtime":0}\n';
      return { exitCode: 0, output, stdout: output };
    }
    if (verb === 'wait') {
      return { exitCode: wait.exitCode, output: wait.output, stdout: wait.output };
    }
    return { exitCode: 0, output: '', stdout: '' };
  };
}

async function waitResult(wait: { exitCode: number; output: string }) {
  const seam = createUmbelSeam(umbelWhoseWaitAnswers(wait), { bin: 'umbel' });
  const worker = await seam.spawnWorker({ cwd: '/tmp' });
  await worker.send('build it');
  return worker.wait({ timeoutMs: 1000 });
}

// The non-zero rows of the contract's table (contracts/fixtures/runner/reasons.jsonl).
const NON_ZERO_REASONS = [
  { exitCode: 122, reason: 'provider-error', message: 'API Error: 529 overloaded' },
  { exitCode: 123, reason: 'idle', message: 'idle 10m: pane still 10m · transcript still 10m' },
  { exitCode: 124, reason: 'timeout', message: 'wait timed out after 30m' },
  { exitCode: 125, reason: 'dead', message: 'process exited 3' },
  { exitCode: 126, reason: 'input', message: 'Claude needs your permission to use Bash' },
] as const;

describe('umbel wait — a non-zero exit with a reason is a result', () => {
  for (const row of NON_ZERO_REASONS) {
    test(`exit ${row.exitCode} with reason ${row.reason} yields a ${row.reason} result`, async () => {
      const output = `${JSON.stringify({ reason: row.reason, message: row.message })}\n`;

      const result = await waitResult({ exitCode: row.exitCode, output });

      // Compared as text: the union gains its missing members in this loop (D23).
      expect(result.reason as string).toBe(row.reason);
      // What was observed travels with every non-progress reason.
      expect(result.message).toBe(row.message);
    });
  }

  test('a non-zero exit with no parsable reason is a seam failure naming the exit and the output', async () => {
    const wait = { exitCode: 1, output: 'umbel: tmux exploded\n' };

    const failure = waitResult(wait);

    expect(failure).rejects.toBeInstanceOf(WorkerSeamError);
    expect(failure).rejects.toThrow(/exited 1/);
    expect(failure).rejects.toThrow(/tmux exploded/);
  });

  test('a non-zero exit whose JSON carries no reason is a seam failure too', async () => {
    const wait = { exitCode: 124, output: '{"stopped":false}\n' };

    const failure = waitResult(wait);

    expect(failure).rejects.toBeInstanceOf(WorkerSeamError);
    expect(failure).rejects.toThrow(/exited 124/);
  });

  test('a stop at exit 0 is read as it always was', async () => {
    const result = await waitResult({ exitCode: 0, output: '{"reason":"stop"}\n' });

    expect(result.reason).toBe('stop');
  });
});
