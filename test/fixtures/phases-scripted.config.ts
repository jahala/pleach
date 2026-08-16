import { gitLedger } from 'pleach/adapters/git';
import { scriptedRunner } from 'pleach/adapters/scripted';
import type { PleachConfig } from 'pleach/config';

// Phases proof (case 0): the {test, phases} TDD cycle driven by the scripted
// runner with REAL gate execution — run-work executes `work.test` for real in
// the worktree after the red and green phases. Two personas:
//
//  honest — red writes a genuinely failing test (seed add() returns 0), impl
//  fixes the source, green confirms. The node must close.
//
//  cheat — red writes an already-passing test (asserts the broken behavior),
//  so the RED gate sees exit 0 and MUST fail the phase: a TDD cycle that
//  never demonstrated a failing test proves nothing. The node must fail.

const HONEST_TEST = `import { expect, test } from 'bun:test';
import { add } from './calc.ts';

test('add sums its arguments', () => {
  expect(add(2, 3)).toBe(5);
});
`;

const CHEAT_TEST = `import { expect, test } from 'bun:test';
import { add } from './calc.ts';

test('add returns zero (asserting the broken seed behavior)', () => {
  expect(add(2, 3)).toBe(0);
});
`;

const CALC_FIXED = `export function add(a: number, b: number): number {
  return a + b;
}
`;

export default {
  runner: scriptedRunner([
    {
      prompt: 'HONEST-RED',
      files: { 'calc.test.ts': HONEST_TEST },
      message: 'wrote a failing test for add',
    },
    {
      prompt: 'HONEST-IMPL',
      files: { 'calc.ts': CALC_FIXED },
      message: 'implemented add',
    },
    {
      prompt: 'HONEST-GREEN',
      message: 'suite is green',
    },
    {
      prompt: 'CHEAT-RED',
      files: { 'calc.test.ts': CHEAT_TEST },
      message: 'wrote a test (that already passes — no failing spec)',
    },
    {
      prompt: 'CHEAT-IMPL',
      files: { 'calc.ts': CALC_FIXED },
      message: 'implemented add',
    },
    {
      prompt: 'CHEAT-GREEN',
      message: 'suite is green',
    },
  ]),
  ledger: gitLedger(),
} satisfies PleachConfig;
