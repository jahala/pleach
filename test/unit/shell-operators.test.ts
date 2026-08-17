// Canary catch (2026-08-17): pleach execs plan command strings WITHOUT a
// shell (SEC1) — so a command like `mkdir -p x && printf … > y` passes '&&'
// and '>' as literal args and mkdir exits 0 having created garbage
// directories. Silent wrongness. The guard: bare shell-operator tokens fail
// LOUD with the bash -lc escape hatch named (ladder law T7: misjudgment costs
// ceremony, never lands garbage).
import { describe, expect, test } from 'bun:test';
import { shellOperatorTokens } from '../../src/core/argv.ts';

describe('shellOperatorTokens (canary catch: no-shell exec semantics)', () => {
  test('flags bare operators', () => {
    expect(
      shellOperatorTokens(['mkdir', '-p', 'tools', '&&', 'printf', 'x', '>', 'tools/w.mjs']),
    ).toEqual(['&&', '>']);
  });

  test('flags the full operator family', () => {
    expect(shellOperatorTokens(['a', '|', 'b', ';', 'c', '||', 'd', '>>', 'e', '<', 'f'])).toEqual([
      '|',
      ';',
      '||',
      '>>',
      '<',
    ]);
  });

  test('operators inside larger tokens are data, not operators', () => {
    expect(shellOperatorTokens(['grep', 'a&&b', '--flag=>x', 'node {evidence}'])).toEqual([]);
  });

  test('clean commands pass', () => {
    expect(shellOperatorTokens(['bun', 'test'])).toEqual([]);
    expect(shellOperatorTokens(['bash', '-lc', 'mkdir -p x && echo hi > y'])).toEqual([]);
  });
});
