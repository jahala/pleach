import { describe, expect, test } from 'bun:test';
import { toArgv } from '../../src/core/argv.ts';
import { ArgvParseError } from '../../src/core/errors.ts';

// ledger: SEC1 / D3 — plan command strings (work.command, accept.smoke, setup,
// work.test) must reach ExecFn as a literal arg-array, never `sh -c <string>`.
// toArgv is a POSIX-style word splitter: quotes/escapes honoured, NO glob, NO
// variable/command substitution. Pure & total.

describe('toArgv — basic splitting', () => {
  test('splits on whitespace', () => {
    expect(toArgv('npm test')).toEqual(['npm', 'test']);
  });

  test('collapses runs of whitespace and trims ends', () => {
    expect(toArgv('  bun   run   check  ')).toEqual(['bun', 'run', 'check']);
  });

  test('empty / whitespace-only string → empty argv', () => {
    expect(toArgv('')).toEqual([]);
    expect(toArgv('   ')).toEqual([]);
  });

  test('tabs and newlines are separators', () => {
    expect(toArgv('a\tb\nc')).toEqual(['a', 'b', 'c']);
  });
});

describe('toArgv — quoting keeps a token intact', () => {
  test('double quotes group spaces into one arg', () => {
    expect(toArgv('git commit -m "a long message"')).toEqual([
      'git',
      'commit',
      '-m',
      'a long message',
    ]);
  });

  test('single quotes group spaces into one arg', () => {
    expect(toArgv("echo 'hello world'")).toEqual(['echo', 'hello world']);
  });

  test('adjacent quoted and unquoted segments concatenate into one token', () => {
    expect(toArgv('foo"bar baz"qux')).toEqual(['foobar bazqux']);
  });

  test('empty quotes produce an empty-string argument', () => {
    expect(toArgv('cmd ""')).toEqual(['cmd', '']);
  });
});

describe('toArgv — escaping (no substitution)', () => {
  test('backslash escapes a space outside quotes', () => {
    expect(toArgv('a\\ b')).toEqual(['a b']);
  });

  test('a literal $ is NOT expanded (no substitution)', () => {
    expect(toArgv('echo $HOME')).toEqual(['echo', '$HOME']);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${FOO} is the asserted output — substitution must NOT happen
    expect(toArgv('echo "${FOO}"')).toEqual(['echo', '${FOO}']);
  });

  test('a literal glob is NOT expanded', () => {
    expect(toArgv('rm *.tmp')).toEqual(['rm', '*.tmp']);
  });
});

describe('toArgv — total on malformed input', () => {
  // ledger: SEC1 / D3 — bare new Error is forbidden outside core/errors.ts (ENGINEERING.md §4)
  test('unterminated double quote → throws ArgvParseError with the command preserved', () => {
    const cmd = 'git commit -m "oops';
    let caught: unknown;
    try {
      toArgv(cmd);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ArgvParseError);
    expect((caught as ArgvParseError).command).toBe(cmd);
  });

  test('unterminated single quote → throws ArgvParseError with the command preserved', () => {
    const cmd = "echo 'hello";
    let caught: unknown;
    try {
      toArgv(cmd);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ArgvParseError);
    expect((caught as ArgvParseError).command).toBe(cmd);
  });
});
