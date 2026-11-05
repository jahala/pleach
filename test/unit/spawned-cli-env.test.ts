// A test that starts the pleach CLI passes the test process's env to it
// (issue #174). The preload sets PLEACH_WORKTREE_HOME to a temp folder, but a
// child started by Bun.spawn without `env` gets the environment the test
// process began with, before the preload ran, and so builds its worktrees in
// the user's real cache. test/e2e/redact.test.ts did that. This scan holds the
// rule for every test file.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_ROOT = join(import.meta.dir, '..');

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

// Every `Bun.spawn(['bun', MAIN, …], { … })` call, with the options object it
// is given: the text from the call to its closing `)`, counted by brackets.
function cliSpawns(source: string): string[] {
  const calls: string[] = [];
  let at = source.indexOf("Bun.spawn(['bun', MAIN");
  while (at !== -1) {
    let depth = 0;
    let end = at;
    for (let i = source.indexOf('(', at); i < source.length; i++) {
      const c = source[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    calls.push(source.slice(at, end + 1));
    at = source.indexOf("Bun.spawn(['bun', MAIN", end);
  }
  return calls;
}

test('every test that starts the pleach CLI passes it an env', () => {
  const missing: string[] = [];
  for (const file of testFiles(TEST_ROOT)) {
    // This file names the pattern it looks for; it starts no CLI.
    if (file === import.meta.path) continue;
    const source = readFileSync(file, 'utf8');
    for (const call of cliSpawns(source)) {
      if (!/\benv\b/.test(call)) missing.push(file.slice(TEST_ROOT.length + 1));
    }
  }
  expect(missing).toEqual([]);
});
