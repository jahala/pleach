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
