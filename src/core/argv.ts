import { ArgvParseError } from './errors.ts';

// Split a plan command string into a literal argv (ledger SEC1 / D3). Plans are
// trusted input, but the contract forbids `sh -c <string>` interpolation
// anywhere — every exec is an arg-array. This is a POSIX-style word splitter:
// it honours single/double quotes and backslash escapes so a command like
// `git commit -m "msg with spaces"` tokenises correctly, but it performs NO
// glob expansion and NO variable/command substitution — a literal `$HOME` or
// `*.tmp` passes through verbatim. Pure & total: malformed quoting throws.

export function toArgv(command: string): string[] {
  const argv: string[] = [];
  let current = '';
  let hasToken = false; // distinguishes `""` (empty arg) from a gap
  let quote: '"' | "'" | null = null;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (quote === null && (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r')) {
      if (hasToken) {
        argv.push(current);
        current = '';
        hasToken = false;
      }
      i += 1;
      continue;
    }

    if (quote === null && (ch === '"' || ch === "'")) {
      quote = ch;
      hasToken = true;
      i += 1;
      continue;
    }

    if (quote !== null && ch === quote) {
      quote = null;
      i += 1;
      continue;
    }

    // Backslash escaping: outside single quotes only (single quotes are literal
    // in POSIX). Outside quotes and inside double quotes, `\<ch>` yields `<ch>`.
    if (ch === '\\' && quote !== "'" && i + 1 < command.length) {
      current += command[i + 1];
      hasToken = true;
      i += 2;
      continue;
    }

    current += ch;
    hasToken = true;
    i += 1;
  }

  if (quote !== null) {
    throw new ArgvParseError(command, `unterminated ${quote === '"' ? 'double' : 'single'} quote`);
  }

  if (hasToken) argv.push(current);
  return argv;
}

// Canary catch (2026-08-17): pleach execs plan command strings WITHOUT a
// shell (SEC1 arg-array). A bare shell-operator token means the author
// expected shell semantics — exec'ing it would pass '&&' or '>' as literal
// arguments and do silently-wrong things (mkdir happily creates a directory
// named 'tools/w.mjs'). Callers fail loud and name the escape hatch instead.
const SHELL_OPERATORS = new Set(['&&', '||', '|', ';', '>', '>>', '<', '&', '2>', '2>&1']);

export function shellOperatorTokens(tokens: readonly string[]): string[] {
  return tokens.filter((t) => SHELL_OPERATORS.has(t));
}

// Why `command` cannot be exec'd without a shell, or null when it can — the one
// wording the exec guard and `validatePlan` share (ledger D19), so a plan
// refused at validate reads exactly as it would have at exec. Tokenises with
// toArgv, so malformed quoting throws ArgvParseError as it would at exec.
export function shellOperatorRefusal(command: string): string | null {
  const ops = shellOperatorTokens(toArgv(command));
  if (ops.length === 0) return null;
  return (
    `contains bare shell operator(s): ${ops.join(' ')} — pleach execs ` +
    `without a shell (arg-array; contract exec semantics). For shell features, ` +
    `wrap the command: bash -lc '<command>'`
  );
}
