/**
 * E2E: `pleach --help` as a real process (ledger D-help). The HELP text
 * advertises the flag, but parseFlags rejected unknown flags BEFORE runCli's
 * help check ran — so the advertised invocation exited 2 with
 * "unknown flag '--help'". Help must print and exit 0, with or without a verb.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const MAIN = join(import.meta.dir, '../../src/main.ts');

async function pleach(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

describe('pleach --help — e2e', () => {
  test('--help prints usage and exits 0', async () => {
    const r = await pleach(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage:');
    expect(r.stdout).toContain('pleach receipt <node>');
  });

  test('-h works too, even alongside a verb', async () => {
    const r = await pleach(['run', '-h']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });

  test('no arguments prints usage but exits 2 (a bare invocation is not a request for help)', async () => {
    const r = await pleach([]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('Usage:');
  });
});

// P6a (bandung): `--version` was "unknown flag" — a bed's garden.lock needs a
// version for every judge. Same rule as help: rides ahead of flag parsing.
describe('pleach --version — e2e', () => {
  test('--version prints the package version and exits 0', async () => {
    const r = await pleach(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
