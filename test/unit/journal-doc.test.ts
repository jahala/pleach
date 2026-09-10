import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KINDS } from '../../src/core/journal-envelope.ts';

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

// ---------------------------------------------------------------------------
// ledger: D15 — every journal line carries a pinned `plotplot.kind`, and the
// journal is a published read surface: a consumer that groups or filters on
// the kind has to be able to read, from the doc alone, which kind each event
// carries. So the doc's kinds table is the documented home of the mapping and
// this pins it to `KINDS` in both directions — a documented event with no kind
// is a run that throws where it should have written a line, and a kind for an
// event nobody documents is a promise made to no one. Neither side is a
// hand-kept list: both are scans of the real text.
// ---------------------------------------------------------------------------

/**
 * The `## The envelope` kinds table, as `event name -> the kind it is listed
 * under`. The table is found by its own header row, so the envelope-keys table
 * above it — whose first column also holds dotted keys — is never read as kinds.
 */
function documentedKinds(md: string): Map<string, string> {
  const start = md.indexOf('\n## The envelope\n');
  if (start === -1) throw new Error('No "## The envelope" section in docs/journal.md');
  const rest = md.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  const kinds = new Map<string, string>();
  let inTable = false;
  for (const line of (end === -1 ? rest : rest.slice(0, end)).split('\n')) {
    if (!line.startsWith('|')) {
      inTable = false;
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells[0] === 'kind') {
      inTable = true;
      continue;
    }
    const kind = inTable ? cells[0]?.match(/^`([a-z.]+)`$/)?.[1] : undefined;
    if (kind === undefined) continue;
    for (const [, name] of (cells[1] ?? '').matchAll(/`([a-z0-9-]+)`/g)) kinds.set(name, kind);
  }
  return kinds;
}

describe('journal doc — kinds', () => {
  const md = readFileSync(JOURNAL_DOC, 'utf8');
  const documented = documentedEvents(md);
  const stated = documentedKinds(md);
  const pinned = Object.keys(KINDS);

  test('both tables are read, not vacuously empty', () => {
    expect(documented.size).toBeGreaterThan(20);
    expect(pinned.length).toBeGreaterThan(20);
  });

  test('every documented event has a pinned kind', () => {
    const unpinned = [...documented.keys()].filter((name) => !Object.hasOwn(KINDS, name)).sort();
    expect(unpinned).toEqual([]);
  });

  test('the kind table names no event the documentation lacks', () => {
    const undocumented = [...new Set([...pinned, ...stated.keys()])]
      .filter((name) => !documented.has(name))
      .sort();
    expect(undocumented).toEqual([]);
  });

  test('the kind table states the pinned kind of every documented event', () => {
    const wrong = [...documented.keys()]
      .filter((name) => stated.get(name) !== KINDS[name])
      .map((name) => `${name}: doc says ${stated.get(name) ?? 'nothing'}, pinned ${KINDS[name]}`)
      .sort();
    expect(wrong).toEqual([]);
  });
});
