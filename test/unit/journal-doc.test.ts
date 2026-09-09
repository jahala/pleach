import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// ledger: D13 — the journal is a published read surface: docs/journal.md's
// stability promise only holds if the events table and the source agree. Both
// directions are pinned here, and the source side is a real scan of the text
// (never a hand-kept list, which drifts silently the moment someone appends).
// ---------------------------------------------------------------------------
const SRC_DIR = new URL('../../src/', import.meta.url).pathname;
const JOURNAL_DOC = new URL('../../docs/journal.md', import.meta.url).pathname;

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

/** Every `event: '<name>'` literal in the source, mapped to where it is appended. */
function appendedEvents(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const path of tsFiles(SRC_DIR)) {
    const src = readFileSync(path, 'utf8');
    for (const [, , name] of src.matchAll(/\bevent:\s*(['"])([a-z0-9-]+)\1/g)) {
      const where = path.slice(SRC_DIR.length);
      found.set(name, [...(found.get(name) ?? []), where]);
    }
  }
  return found;
}

/** The rows of the `## Events` table, as `name -> the row's full text`. */
function documentedEvents(md: string): Map<string, string> {
  const start = md.indexOf('\n## Events\n');
  if (start === -1) throw new Error('No "## Events" section in docs/journal.md');
  const rest = md.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  const rows = new Map<string, string>();
  for (const line of (end === -1 ? rest : rest.slice(0, end)).split('\n')) {
    if (!line.startsWith('|')) continue;
    const cell = line.split('|')[1]?.trim() ?? '';
    const name = cell.match(/^`([a-z0-9-]+)`$/)?.[1];
    if (name !== undefined) rows.set(name, line);
  }
  return rows;
}

describe('journal doc', () => {
  const documented = documentedEvents(readFileSync(JOURNAL_DOC, 'utf8'));
  const appended = appendedEvents();

  test('the events table is parsed, not vacuously empty', () => {
    expect(documented.size).toBeGreaterThan(20);
    expect(appended.size).toBeGreaterThan(20);
  });

  test('`phase-commit` is documented with the fields the seal appends (D13)', () => {
    const row = documented.get('phase-commit');
    expect(row).toBeDefined();
    for (const field of ['node', 'phase', 'sha', 'files']) {
      expect(row).toContain(`\`${field}\``);
    }
  });

  test('every event the source appends is documented', () => {
    const undocumented = [...appended.entries()]
      .filter(([name]) => !documented.has(name))
      .map(([name, where]) => `${name} (appended in ${where.join(', ')})`)
      .sort();
    expect(undocumented).toEqual([]);
  });

  test('every documented event is appended by the source', () => {
    const phantom = [...documented.keys()].filter((name) => !appended.has(name)).sort();
    expect(phantom).toEqual([]);
  });
});
