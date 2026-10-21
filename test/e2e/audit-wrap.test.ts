/**
 * E2E: `pleach audit-wrap` turns an ordinary check into a command that prints a
 * parseable tend-audit-result block (issue #149). Through the real CLI: a
 * passing command prints a pass verdict, a failing one a fail verdict carrying
 * the exit code and the output tail, --check names the check id, and a missing
 * command is a usage error.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { extractAuditJson } from '../../src/core/audit-egress.ts';
import { AuditResultSchema } from '../../src/core/plan.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function pleach(args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, stdout, stderr };
}

function verdict(stdout: string) {
  return AuditResultSchema.parse(extractAuditJson(stdout));
}

describe('pleach audit-wrap — e2e (issue #149)', () => {
  test('wraps a passing command in a passing verdict block, exiting 0', async () => {
    const r = await pleach(['audit-wrap', '--', 'bash', '-lc', 'echo ok']);
    expect(r.code).toBe(0);
    expect(verdict(r.stdout).verdicts[0]).toMatchObject({
      verdict: 'pass',
      reasons: ['exit 0', 'ok'],
    });
  });

  test('a failing command prints a fail verdict with the exit code and output in the reasons', async () => {
    const r = await pleach(['audit-wrap', '--', 'bash', '-lc', 'echo bad; exit 3']);
    expect(r.code).toBe(0);
    const v = verdict(r.stdout).verdicts[0];
    expect(v.verdict).toBe('fail');
    expect(v.reasons).toContain('exit 3');
    expect(v.reasons).toContain('bad');
  });

  test('--check names the check id in the verdict', async () => {
    const r = await pleach(['audit-wrap', '--check', 'my-check', '--', 'bash', '-lc', 'echo ok']);
    expect(r.code).toBe(0);
    expect(verdict(r.stdout).verdicts[0]).toMatchObject({
      check: 'my-check',
      verdict: 'pass',
    });
  });

  // ledger: D33 — the wrapped command's own --help and --version are the command's.
  test('flags after -- belong to the command, even --help and --version', async () => {
    for (const flag of ['--help', '--version']) {
      // bash prints its first argument as data on every platform; GNU echo
      // would answer --help with its own help text.
      const r = await pleach(['audit-wrap', '--', 'bash', '-c', 'printf "%s\\n" "$1"', '_', flag]);
      expect(r.code).toBe(0);
      expect(verdict(r.stdout).verdicts[0]).toMatchObject({
        verdict: 'pass',
        reasons: ['exit 0', flag],
      });
    }
  });

  test('a missing command is a usage error (exit 2)', async () => {
    const r = await pleach(['audit-wrap', '--']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
  });
});
