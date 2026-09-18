import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellOperatorRefusal } from '../../src/core/argv.ts';
import { SPAWN_FAILED_EXIT } from '../../src/core/classify.ts';
import { KINDS } from '../../src/core/journal-envelope.ts';
import { VerdictSchema } from '../../src/core/plan.ts';

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

// ---------------------------------------------------------------------------
// ledger: D16 — halting a run has a vocabulary, and it is published in four
// places an operator reads: the journal's `verdict` row (the status a halted
// node settles in), its `run-end` row (the bucket that names the node), the
// CLI help and the README (the verb and the flag that halt a run in the first
// place). Each is pinned to its own source — the status list to the contract's
// enum, the run-end fields to `RunSummary`, the help to the verbs and flags the
// CLI really dispatches and parses, the README's usage block to the help. A
// control that exists in code and nowhere an operator looks is a control
// nobody can find; none of these lists is hand-kept.
// ---------------------------------------------------------------------------
const CLI_SRC = new URL('../../src/faces/cli.ts', import.meta.url).pathname;
const DEPS_SRC = new URL('../../src/loop/deps.ts', import.meta.url).pathname;
const README = new URL('../../README.md', import.meta.url).pathname;

/** A table row's cells; `\|` is content inside a cell, not a separator. */
function rowCells(row: string): string[] {
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/** The vocabulary a row's fields cell states for one field: `` `f` (`a`\|`b`) ``. */
function statedVocabulary(row: string, field: string): string[] {
  const fields = rowCells(row)[2] ?? '';
  const at = fields.indexOf(`\`${field}\` (`);
  if (at === -1) return [];
  const listed = fields.slice(at).match(/\(([^)]*)\)/)?.[1] ?? '';
  return [...listed.matchAll(/`([a-z]+)`/g)].map(([, name]) => name).sort();
}

/** The buckets a `RunSummary` reports — every `name: string[]` of the interface. */
function summaryBuckets(): string[] {
  const src = readFileSync(DEPS_SRC, 'utf8');
  const start = src.indexOf('export interface RunSummary {');
  if (start === -1) throw new Error('No RunSummary interface in src/loop/deps.ts');
  const body = src.slice(start, src.indexOf('\n}', start));
  return [...body.matchAll(/^ {2}([A-Za-z]+): string\[\];$/gm)].map(([, name]) => name);
}

/** The help block the CLI prints, read out of its source. */
function helpText(): string {
  const src = readFileSync(CLI_SRC, 'utf8');
  const open = src.indexOf('const HELP = `');
  if (open === -1) throw new Error('No HELP block in src/faces/cli.ts');
  const from = open + 'const HELP = `'.length;
  const close = src.indexOf('\n`;', from);
  if (close === -1) throw new Error('Unterminated HELP block in src/faces/cli.ts');
  return src.slice(from, close);
}

/** Every verb `runCli` dispatches on — its real comparisons and case labels. */
function dispatchedVerbs(): string[] {
  const src = readFileSync(CLI_SRC, 'utf8');
  const compared = [...src.matchAll(/verb === '([a-z][a-z-]*)'/g)].map(([, verb]) => verb);
  const cased = [...src.matchAll(/case '([a-z][a-z-]*)':/g)].map(([, verb]) => verb);
  return [...new Set([...compared, ...cased])].sort();
}

/** Every long flag `parseFlags` accepts — a flag case is the only `case '--…'`. */
function parsedFlags(): string[] {
  const src = readFileSync(CLI_SRC, 'utf8');
  return [...new Set([...src.matchAll(/case '(--[a-z-]+)':/g)].map(([, flag]) => flag))].sort();
}

/** The verbs the README's `## Usage` block lists. */
function usageVerbs(md: string): string[] {
  const start = md.indexOf('\n## Usage\n');
  if (start === -1) throw new Error('No "## Usage" section in README.md');
  const fence = md.indexOf('```', start);
  const end = md.indexOf('```', fence + 3);
  if (fence === -1 || end === -1) {
    throw new Error('No fenced usage block under README.md "## Usage"');
  }
  return [...md.slice(fence, end).matchAll(/^pleach ([a-z][a-z-]*)/gm)].map(([, verb]) => verb);
}

describe('journal doc — the halted-run vocabulary (D16)', () => {
  const documented = documentedEvents(readFileSync(JOURNAL_DOC, 'utf8'));

  test("the `verdict` row states the contract's whole status vocabulary", () => {
    const row = documented.get('verdict');
    expect(row).toBeDefined();
    expect(statedVocabulary(row ?? '', 'status')).toEqual(
      [...VerdictSchema.shape.status.options].sort(),
    );
  });

  test('the `run-end` row names every bucket a RunSummary reports', () => {
    const row = documented.get('run-end');
    expect(row).toBeDefined();
    const fields = rowCells(row ?? '')[2] ?? '';
    const unnamed = summaryBuckets().filter((bucket) => !fields.includes(`\`${bucket}\``));
    expect(unnamed).toEqual([]);
  });
});

describe('operator surfaces — the CLI help and the README (D16)', () => {
  const help = helpText();
  const readme = readFileSync(README, 'utf8');

  test('both surfaces are read, not vacuously empty', () => {
    expect(dispatchedVerbs().length).toBeGreaterThan(4);
    expect(parsedFlags().length).toBeGreaterThan(8);
    expect(usageVerbs(readme).length).toBeGreaterThan(2);
  });

  test('the help advertises every verb the CLI dispatches and every flag it parses', () => {
    const unadvertised = [...dispatchedVerbs().map((verb) => `pleach ${verb}`), ...parsedFlags()]
      .filter((token) => !help.includes(token))
      .sort();
    expect(unadvertised).toEqual([]);
  });

  test("the README's usage block lists every verb the CLI dispatches", () => {
    const listed = usageVerbs(readme);
    const missing = dispatchedVerbs().filter((verb) => !listed.includes(verb));
    expect(missing).toEqual([]);
  });

  test('the README names the controls that halt a run (D16)', () => {
    expect(readme).toContain('pleach stop');
    expect(readme).toContain('--idle-ms');
  });
});

// ---------------------------------------------------------------------------
// ledger: D17 — nothing a worker produced is lost, and every part of that
// promise has an operator surface: the journal row that names what was kept
// beside a receipt, the row that names a tree a run resumed from, and the two
// places (`pleach --help`, the README) where the controls that keep or refuse
// that work are found. Each is pinned to its own source — the artifact row's
// gates to the calls that really keep an artifact, the filenames to the store
// that really writes them, the controls to the verbs and flags the CLI really
// dispatches and parses. A kind kept in code and absent from the doc is bytes
// on disk nobody knows to read; a control named nowhere an operator looks is a
// control nobody can find. None of these lists is hand-kept.
// ---------------------------------------------------------------------------
const RUN_PLAN_SRC = new URL('../../src/loop/run-plan.ts', import.meta.url).pathname;
const RECEIPTS_SRC = new URL('../../src/seams/receipts.ts', import.meta.url).pathname;

/** Every artifact a close really keeps, as `gate name -> ArtifactKind`. */
function keptArtifacts(): Map<string, string> {
  const src = readFileSync(RUN_PLAN_SRC, 'utf8');
  const calls = src.matchAll(/keepOrJournal\(\s*node,\s*'([a-z-]+)',\s*'([a-z-]+)'/g);
  return new Map([...calls].map(([, gate, kind]) => [gate, kind]));
}

/** The file suffix the receipt store gives each kind, as `kind -> suffix`. */
function artifactExtensions(): Map<string, string> {
  const src = readFileSync(RECEIPTS_SRC, 'utf8');
  const start = src.indexOf('const ARTIFACT_EXTENSION: Record<ArtifactKind, string> = {');
  if (start === -1) throw new Error('No ARTIFACT_EXTENSION table in src/seams/receipts.ts');
  const body = src.slice(start, src.indexOf('\n};', start));
  return new Map([...body.matchAll(/^ {2}([a-z]+): '([^']+)',$/gm)].map(([, k, ext]) => [k, ext]));
}

/** The `ArtifactKind` union's members, as the store's own type declares them. */
function artifactKinds(): string[] {
  const src = readFileSync(DEPS_SRC, 'utf8');
  const decl = src.match(/export type ArtifactKind =([^;]+);/)?.[1];
  if (decl === undefined) throw new Error('No ArtifactKind union in src/loop/deps.ts');
  return [...decl.matchAll(/'([a-z-]+)'/g)].map(([, kind]) => kind).sort();
}

describe('journal doc — what a close keeps beside its receipt (D17)', () => {
  const documented = documentedEvents(readFileSync(JOURNAL_DOC, 'utf8'));
  const kept = keptArtifacts();
  const extensions = artifactExtensions();

  test('the artifact surfaces are read, not vacuously empty', () => {
    expect(kept.size).toBeGreaterThan(1);
    expect([...kept.values()].sort()).toEqual(artifactKinds());
    expect([...extensions.keys()].sort()).toEqual(artifactKinds());
  });

  test('the `gate-artifact` row states every gate a close keeps something under', () => {
    const row = documented.get('gate-artifact');
    expect(row).toBeDefined();
    expect(statedVocabulary(row ?? '', 'gate')).toEqual([...kept.keys()].sort());
  });

  test('the `gate-artifact` row names the file each kind is kept as', () => {
    const row = documented.get('gate-artifact') ?? '';
    const unnamed = [...kept.values()]
      .map((kind) => extensions.get(kind) ?? kind)
      .filter((suffix) => !row.includes(`\`${suffix}\``))
      .sort();
    expect(unnamed).toEqual([]);
  });

  test('the `resumed-from-quarantine` row names the fields the resume appends', () => {
    const row = documented.get('resumed-from-quarantine');
    expect(row).toBeDefined();
    for (const field of ['node', 'sha']) expect(row).toContain(`\`${field}\``);
  });

  test('the kinds table pins the events that record a resume', () => {
    for (const name of ['resumed-from-quarantine', 'resume-refused', 'gate-artifact']) {
      expect(KINDS[name]).toBe('node.lifecycle');
    }
  });
});

// The controls that decide what happens to work a worker already produced: the
// verb that re-adjudicates a quarantined build, the flag that re-casts a dead
// attempt somewhere else, and the flag that refuses a resume.
const KEEPING_CONTROLS = ['pleach audit', '--fallback-provider', '--fresh'];

describe('operator surfaces — the controls over kept work (D17)', () => {
  const help = helpText();
  const readme = readFileSync(README, 'utf8');

  test('every control named here is one the CLI really has', () => {
    const real = [...dispatchedVerbs().map((verb) => `pleach ${verb}`), ...parsedFlags()];
    const phantom = KEEPING_CONTROLS.filter((control) => !real.includes(control)).sort();
    expect(phantom).toEqual([]);
  });

  test('the help names every control over kept work', () => {
    expect(KEEPING_CONTROLS.filter((control) => !help.includes(control))).toEqual([]);
  });

  test('the README names every control over kept work', () => {
    expect(KEEPING_CONTROLS.filter((control) => !readme.includes(control))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ledger: D18 — a landing has controls of its own now: `--sinks` names the
// verified subset to land, and `--land-gate` runs the operator's own check on
// the composed stack, refusing the landing when it goes red. A refusal is only
// actionable if the row names what the line carries, and a control exists for
// an operator only where an operator looks. So the rows D18 wrote are pinned
// to the appends that really write them, the refusal to its kind, and the two
// flags to the flags the CLI really parses, to `pleach --help`, and to the
// README — including the one token a gate's command substitutes, read from the
// loop's own constant. A gate that refuses in silence is a landing nobody can
// explain; a flag documented nowhere is a landing nobody can shape.
// ---------------------------------------------------------------------------
const LAND_SRC = new URL('../../src/loop/land.ts', import.meta.url).pathname;

// The rows D18 wrote: the refusal it added, and the start line it gave a new
// field. Their fields are read from the source, never listed here.
const LANDING_ROWS = ['land-start', 'land-gate-refused'];

// The controls a landing has that a run does not.
const LANDING_CONTROLS = ['--sinks', '--land-gate'];

/** Every field a `journal.append` literal really carries, as `event -> fields`. */
function appendedFields(path: string): Map<string, Set<string>> {
  const src = readFileSync(path, 'utf8');
  const fields = new Map<string, Set<string>>();
  for (const [, body] of src.matchAll(/journal\.append\(\{([\s\S]*?)\}\)/g)) {
    const event = body.match(/event:\s*'([a-z0-9-]+)'/)?.[1];
    if (event === undefined) continue;
    const seen = fields.get(event) ?? new Set<string>();
    // Both spellings a key can take in the literal: `name: value` and shorthand.
    for (const [, key] of body.matchAll(/(?:^|[{,])\s*([A-Za-z][A-Za-z0-9]*)\s*(?=[:,]|\s*$)/g)) {
      if (key !== 'event') seen.add(key);
    }
    fields.set(event, seen);
  }
  return fields;
}

/** The one token a `--land-gate` command substitutes, as the loop declares it. */
function baseToken(): string {
  const src = readFileSync(LAND_SRC, 'utf8');
  const token = src.match(/^const BASE_TOKEN = '([^']+)';$/m)?.[1];
  if (token === undefined) throw new Error('No BASE_TOKEN constant in src/loop/land.ts');
  return token;
}

describe('journal doc — the landing rows (D18)', () => {
  const documented = documentedEvents(readFileSync(JOURNAL_DOC, 'utf8'));
  const appended = appendedFields(LAND_SRC);

  test('the landing appends are read, not vacuously empty', () => {
    expect(appended.size).toBeGreaterThan(8);
    for (const event of LANDING_ROWS) {
      expect(appended.get(event)?.size ?? 0).toBeGreaterThan(1);
    }
  });

  test('each row names every field the landing really appends under it', () => {
    const unnamed = LANDING_ROWS.flatMap((event) => {
      const row = documented.get(event) ?? '';
      return [...(appended.get(event) ?? [])]
        .filter((field) => !row.includes(`\`${field}\``) && !row.includes(`\`${field}[]\``))
        .map((field) => `${event}.${field}`);
    }).sort();
    expect(unnamed).toEqual([]);
  });

  test('the kinds table pins a refused land gate as a gate result', () => {
    expect(KINDS['land-gate-refused']).toBe('gate.result');
  });
});

describe('operator surfaces — the landing controls (D18)', () => {
  const help = helpText();
  const readme = readFileSync(README, 'utf8');

  test('every control named here is one the CLI really parses', () => {
    const phantom = LANDING_CONTROLS.filter((flag) => !parsedFlags().includes(flag)).sort();
    expect(phantom).toEqual([]);
  });

  test('the help names every landing control, and the token a gate substitutes', () => {
    expect(LANDING_CONTROLS.filter((control) => !help.includes(control))).toEqual([]);
    expect(help).toContain(baseToken());
  });

  test('the README names every landing control, and the token a gate substitutes', () => {
    expect(LANDING_CONTROLS.filter((control) => !readme.includes(control))).toEqual([]);
    expect(readme).toContain(baseToken());
  });
});

// ---------------------------------------------------------------------------
// ledger: D19 — a fault the conductor can name for free is named before a
// worker spends anything, and each part of that has an operator surface. A
// `verdict` line now says whether a worker ever spawned, so the row that
// documents the line is pinned to every `verdict` append in the source — each
// field it can carry named, and a field every line carries named without `?`,
// which is what lets a consumer read it without a presence check. `pleach
// validate` refuses a bare shell operator with the wording exec refuses it
// with, and a gate that cannot run at all settles its node once: the help and
// the README say both, pinned to the refusal the code really prints, the
// detail a cannot-run settle really writes, and the exit the exec seam really
// reports. None of these is a hand-kept list.
// ---------------------------------------------------------------------------
const RUN_NODE_SRC = new URL('../../src/loop/run-node.ts', import.meta.url).pathname;

const OPENERS = '{([';
const CLOSERS = '})]';

/**
 * The last index of the string literal or comment that starts at `at`, or `at`
 * itself when none starts there — so a brace, comma or apostrophe inside one is
 * never read as structure.
 */
function tokenEnd(src: string, at: number): number {
  const ch = src.charAt(at);
  if (src.startsWith('//', at)) {
    const eol = src.indexOf('\n', at);
    return eol === -1 ? src.length - 1 : eol - 1;
  }
  if (src.startsWith('/*', at)) {
    const end = src.indexOf('*/', at + 2);
    return end === -1 ? src.length - 1 : end + 1;
  }
  if (ch === "'" || ch === '"' || ch === '`') {
    let i = at + 1;
    while (i < src.length && src.charAt(i) !== ch) i += src.charAt(i) === '\\' ? 2 : 1;
    return i;
  }
  return at;
}

/** `src` with its comments dropped and its string literals kept whole. */
function uncommented(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const end = tokenEnd(src, i);
    if (!src.startsWith('//', i) && !src.startsWith('/*', i)) out += src.slice(i, end + 1);
    i = end + 1;
  }
  return out;
}

/** The text inside the bracket at `open`, up to the bracket that closes it. */
function bracketed(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i = tokenEnd(src, i) + 1) {
    const ch = src.charAt(i);
    if (OPENERS.includes(ch)) depth += 1;
    if (CLOSERS.includes(ch)) {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`Unbalanced bracket at offset ${open}`);
}

/** An object literal's body, cut at its own top-level commas. */
function literalEntries(body: string): string[] {
  const cut: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < body.length; i = tokenEnd(body, i) + 1) {
    const ch = body.charAt(i);
    if (OPENERS.includes(ch)) depth += 1;
    else if (CLOSERS.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) {
      cut.push(body.slice(from, i));
      from = i + 1;
    }
  }
  cut.push(body.slice(from));
  return cut.map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/** The bodies of the object literals at an expression's own top level. */
function objectBodies(expr: string): string[] {
  const bodies: string[] = [];
  let depth = 0;
  for (let i = 0; i < expr.length; i = tokenEnd(expr, i) + 1) {
    const ch = expr.charAt(i);
    if (ch === '{' && depth === 0) {
      const body = bracketed(expr, i);
      bodies.push(body);
      i += body.length + 1;
    } else if (OPENERS.includes(ch)) depth += 1;
    else if (CLOSERS.includes(ch)) depth -= 1;
  }
  return bodies;
}

interface LiteralKey {
  key: string;
  /** Written by the literal itself, not added by a conditional spread. */
  always: boolean;
}

/** Every key an object literal writes: its own, and those `...(c ? { k } : {})` adds. */
function literalKeys(body: string, always = true): LiteralKey[] {
  return literalEntries(body).flatMap((entry) => {
    if (entry.startsWith('...(')) {
      return objectBodies(bracketed(entry, 3)).flatMap((inner) => literalKeys(inner, false));
    }
    const key = entry.match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/)?.[1];
    return key === undefined ? [] : [{ key, always }];
  });
}

/** Every `journal.append({ event: '<event>', … })` literal in the source, as its keys. */
function appendLiterals(event: string): LiteralKey[][] {
  return tsFiles(SRC_DIR).flatMap((path) => {
    const raw = readFileSync(path, 'utf8');
    if (!raw.includes(`event: '${event}'`)) return [];
    const src = uncommented(raw);
    return [...src.matchAll(/journal\.append\(\{/g)]
      .map((call) => bracketed(src, (call.index ?? 0) + call[0].length - 1))
      .filter((body) => literalEntries(body).includes(`event: '${event}'`))
      .map((body) => literalKeys(body).filter(({ key }) => key !== 'event'));
  });
}

/** The fields an event's lines can carry, as `field -> whether every line carries it`. */
function lineFields(literals: LiteralKey[][]): Map<string, boolean> {
  const fields = new Map<string, boolean>();
  for (const { key } of literals.flat()) {
    fields.set(
      key,
      literals.every((keys) => keys.some((k) => k.key === key && k.always)),
    );
  }
  return fields;
}

describe('journal doc — what a verdict line carries (D19)', () => {
  const documented = documentedEvents(readFileSync(JOURNAL_DOC, 'utf8'));
  const literals = appendLiterals('verdict');
  const fields = lineFields(literals);
  const fieldsCell = rowCells(documented.get('verdict') ?? '')[2] ?? '';

  test('the verdict appends are read, not vacuously empty', () => {
    expect(literals.length).toBeGreaterThan(1);
    expect(fields.size).toBeGreaterThan(8);
    // The stability promise the row states: `provider` is never absent.
    expect(fields.get('provider')).toBe(true);
  });

  test('the `verdict` row names every field a verdict line can carry', () => {
    const unnamed = [...fields.keys()]
      .filter((f) => !fieldsCell.includes(`\`${f}\``) && !fieldsCell.includes(`\`${f}?\``))
      .sort();
    expect(unnamed).toEqual([]);
  });

  test('a field every verdict line carries is named without `?`', () => {
    const optional = [...fields.entries()]
      .filter(([f, always]) => always && !fieldsCell.includes(`\`${f}\``))
      .map(([f]) => f)
      .sort();
    expect(optional).toEqual([]);
  });
});

/** A text's paragraphs — its runs of lines between blank lines — each on one line. */
function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim());
}

/** A verb's entry in the help's usage block — its line and the lines continuing it — on one line. */
function usageEntry(help: string, verb: string): string {
  const lines = help.split('\n');
  const at = lines.findIndex((line) => line.startsWith(`  pleach ${verb} `));
  if (at === -1) return '';
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((line) => !/^ {3,}\S/.test(line));
  return lines
    .slice(at, at + 1 + (end === -1 ? rest.length : end))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The detail a gate that cannot run settles with, as run-node words it, by fault. */
function cannotRunDetails(): Map<string, string> {
  const src = readFileSync(RUN_NODE_SRC, 'utf8');
  const start = src.indexOf('const CANNOT_RUN: Record<GateFault, string> = {');
  if (start === -1) throw new Error('No CANNOT_RUN table in src/loop/run-node.ts');
  const body = src.slice(start, src.indexOf('\n};', start));
  return new Map(
    [...body.matchAll(/^ {2}([a-z]+): (['"])(.*)\2,$/gm)].map(([, fault, , text]) => [fault, text]),
  );
}

/** Whether `text` says `fact` as a whole word or phrase. */
function says(text: string, fact: string): boolean {
  const literal = fact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${literal}(?![\\w-])`).test(text);
}

/** What the best paragraph of `text` that speaks of `topic` leaves unsaid of `facts`. */
function unsaid(text: string, topic: string, facts: string[]): string[] {
  const candidates = paragraphs(text)
    .filter((p) => says(p, topic))
    .map((p) => facts.filter((fact) => !says(p, fact)));
  if (candidates.length === 0) return [topic, ...facts];
  return candidates.reduce((best, missing) => (missing.length < best.length ? missing : best));
}

describe('operator surfaces — faults refused before spend (D19)', () => {
  const help = helpText();
  const readme = readFileSync(README, 'utf8');
  // The one wording validate and the exec guard share, read by calling it.
  const refusal = shellOperatorRefusal('true && true') ?? '';
  const hatch = refusal.split(': ').at(-1) ?? '';
  const details = cannotRunDetails();
  // What a surface must say of a gate that cannot run: whose fault it can be,
  // the exit a command the environment cannot spawn reports, and that it is
  // settled once.
  const cannotRunFacts = [...details.keys(), String(SPAWN_FAILED_EXIT), 'once'];

  test('the wording is read from the code, not vacuously empty', () => {
    expect(refusal).toContain('shell operator');
    expect(hatch).toContain('bash -lc');
    expect(details.size).toBeGreaterThan(1);
    for (const detail of details.values()) expect(detail).toContain('cannot run');
  });

  test('the help says validate refuses a shell operator, and names the escape hatch', () => {
    const entry = usageEntry(help, 'validate');
    expect(entry).toContain('pleach validate');
    expect(['shell operator', hatch].filter((fact) => !entry.includes(fact))).toEqual([]);
  });

  test('the README says validate refuses a shell operator, and names the escape hatch', () => {
    expect(unsaid(readme, 'pleach validate', ['shell operator', hatch])).toEqual([]);
  });

  test('the help says a gate that cannot run fails its node once, and whose fault it is', () => {
    expect(unsaid(help, 'cannot run', cannotRunFacts)).toEqual([]);
  });

  test('the README says a gate that cannot run fails its node once, and whose fault it is', () => {
    expect(unsaid(readme, 'cannot run', cannotRunFacts)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ledger: D21 — the record survives what the repository does, and each part of
// that has a surface a reader finds it on. The journal rows D21 wrote or widened
// name every field their appends really carry, and the `blocked` row names the
// file a worker writes to explain itself, with the cap its text is kept under;
// the kinds table pins the new events. The README states the three behaviours
// an operator meets: a commit the repository's hook refuses settles failed and
// keeps the tree, a lost journal is reported and recoverable, and BLOCKED.md
// settles its node at once. The file name, the cap, the gate a refusal names
// and where a run's copy is kept are read from the code, never listed here.
// ---------------------------------------------------------------------------
const ISOLATE_SRC = new URL('../../src/seams/isolate.ts', import.meta.url).pathname;

// The rows D21 wrote, and the rows whose meaning it widened.
const RECORD_ROWS = [
  'run-start',
  'journal-gap',
  'journal-gap-check-failed',
  'run-end',
  'journal-copy-failed',
  'blocked',
];

// The run-level events D21 added.
const RECORD_EVENTS = ['journal-gap', 'journal-gap-check-failed', 'journal-copy-failed'];

/** One capture out of a source file, or a loud failure naming what is missing. */
function sourced(path: string, pattern: RegExp, what: string): string {
  const found = readFileSync(path, 'utf8').match(pattern)?.[1];
  if (found === undefined) throw new Error(`No ${what} in ${path}`);
  return found;
}

/** The file a worker writes at the tree's root when the plan cannot be finished. */
function blockedFile(): string {
  return sourced(ISOLATE_SRC, /^const BLOCKED_FILE = '([^']+)';$/m, 'BLOCKED_FILE constant');
}

/** How much of that file's text the verdict keeps. */
function blockedReasonCap(): string {
  return sourced(RUN_NODE_SRC, /^const BLOCKED_REASON_CAP = (\d+);$/m, 'BLOCKED_REASON_CAP');
}

/** Where a run's copy of its own lines is kept, as `receipts/<dir>/` and its suffix. */
function runCopyPlace(): { dir: string; suffix: string } {
  return {
    dir: `receipts/${sourced(RECEIPTS_SRC, /^const RUNS = '([^']+)';$/m, 'RUNS constant')}/`,
    suffix: sourced(RECEIPTS_SRC, /\$\{runId\}(\.[a-z.]+)`/, 'run journal suffix'),
  };
}

/** The gate a refused verified commit settles its node under. */
function refusedCommitGate(): string {
  return sourced(
    RUN_PLAN_SRC,
    /err instanceof GateFailedError \? err\.gate : '([a-z]+)'/,
    'refused-commit gate',
  );
}

describe('journal doc — the record survives (D21)', () => {
  const documented = documentedEvents(readFileSync(JOURNAL_DOC, 'utf8'));
  const literals = new Map(RECORD_ROWS.map((event) => [event, appendLiterals(event)]));

  test('the record appends are read, not vacuously empty', () => {
    for (const event of RECORD_ROWS) expect(literals.get(event)?.length ?? 0).toBeGreaterThan(0);
    expect(lineFields(literals.get('run-end') ?? []).has('journalCopy')).toBe(true);
    expect(lineFields(literals.get('run-start') ?? []).has('runId')).toBe(true);
  });

  test('each row names every field its appends really carry', () => {
    const unnamed = RECORD_ROWS.flatMap((event) => {
      const fieldsCell = rowCells(documented.get(event) ?? '')[2] ?? '';
      return [...lineFields(literals.get(event) ?? []).keys()]
        .filter((f) => !fieldsCell.includes(`\`${f}\``))
        .map((f) => `${event}.${f}`);
    }).sort();
    expect(unnamed).toEqual([]);
  });

  test('the `run-end` row names where the run keeps its copy', () => {
    const row = documented.get('run-end') ?? '';
    const { dir, suffix } = runCopyPlace();
    expect([dir, suffix].filter((part) => !row.includes(part))).toEqual([]);
  });

  test('the `blocked` row names the file a worker explains itself in, and its cap', () => {
    const row = documented.get('blocked') ?? '';
    expect([`\`${blockedFile()}\``, blockedReasonCap()].filter((f) => !row.includes(f))).toEqual(
      [],
    );
  });

  test('the kinds table pins the events that witness the journal', () => {
    for (const name of RECORD_EVENTS) expect(KINDS[name]).toBe('run.lifecycle');
    expect(KINDS.blocked).toBe('node.lifecycle');
  });
});

describe('operator surfaces — the record survives (D21)', () => {
  const readme = readFileSync(README, 'utf8');
  const { dir, suffix } = runCopyPlace();

  test('the facts are read from the code, not vacuously empty', () => {
    expect(blockedFile()).toBe('BLOCKED.md');
    expect(Number(blockedReasonCap())).toBeGreaterThan(0);
    expect(refusedCommitGate()).toBe('commit');
    expect(suffix).toContain('journal');
  });

  test("the README says a hook's refusal settles the node failed and keeps its tree", () => {
    const facts = [refusedCommitGate(), 'failed', 'snapshot', 'quarantine/<id>', 'receipt'];
    expect(unsaid(readme, 'hook', facts)).toEqual([]);
  });

  test('the README says a lost journal is reported, and where each run keeps its copy', () => {
    expect(unsaid(readme, 'journal-gap', ['run-start', 'run-end', dir, suffix])).toEqual([]);
  });

  test('the README says BLOCKED.md settles its node blocked at once, with no retry', () => {
    const facts = ['blocked', 'blockedReason', 'quarantine/<id>', 'no retry'];
    expect(unsaid(readme, blockedFile(), facts)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ledger: D23 — a seam's surprise never costs the tree, and a reader finds how
// on two surfaces. The journal: the `seam-violation` row names what its appends
// carry and the kinds table pins it; the `verdict` row names the gate a
// surprise settles under and the next step its detail states. docs/adapters.md
// states the runner contract: the reason is read from the wait's JSON whatever
// the exit code, and each of the nine reasons of `contracts/runner.md` with its
// exit code and its class. The gate, the lanes, the next step and the reasons
// are read from the code and the vendored fixture, never listed here.
// ---------------------------------------------------------------------------
const ADAPTERS_DOC = new URL('../../docs/adapters.md', import.meta.url).pathname;
const RUNNER_FIXTURE = new URL('../fixtures/runner-reasons.jsonl', import.meta.url).pathname;

/** The contract's reasons, from the vendored copy of its fixture. */
function contractReasons(): { reason: string; exitCode: number; classification: string }[] {
  return readFileSync(RUNNER_FIXTURE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The gate a surprise settles under, as run-node spells it, with `<lane>` for the lane. */
function surpriseGate(): string {
  return `${sourced(RUN_NODE_SRC, /const gate = `([a-z]+:)\$\{lane\}`;/, 'surprise gate')}<lane>`;
}

/** The lanes of a node's ladder a surprise can come from. */
function seamLanes(): string[] {
  const union = sourced(RUN_NODE_SRC, /^type SeamLane = ([^;]+);$/m, 'SeamLane type');
  return [...union.matchAll(/'([a-z]+)'/g)].map(([, lane]) => lane);
}

/** The step a surprise in the audit lane names, with `<node>` for the node's id. */
function auditNextStep(): string {
  const step = sourced(
    RUN_NODE_SRC,
    /if \(lane === 'audit'\) return `([^`$]+)\$\{node\.id\}`;/,
    'audit next step',
  );
  return `${step}<node>`;
}

/** docs/adapters.md's table rows, as `first cell -> the row's cells`. */
function tableRows(md: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = rowCells(line).slice(1, -1);
    rows.set(cells[0] ?? '', cells);
  }
  return rows;
}

/** The reasons docs/adapters.md's `WorkerResult` block lists for `reason?:`. */
function documentedUnion(md: string): string[] {
  const at = md.indexOf('export interface WorkerResult {');
  if (at === -1) return [];
  const block = md.slice(at, md.indexOf('\n}', at));
  const union = block.match(/reason\?:([^;]*);/)?.[1] ?? '';
  return [...union.matchAll(/'([a-z-]+)'/g)].map(([, reason]) => reason).sort();
}

describe('journal doc — a surprise settles its node (D23)', () => {
  const documented = documentedEvents(readFileSync(JOURNAL_DOC, 'utf8'));
  const violation = appendLiterals('seam-violation');

  test('the facts are read from the code, not vacuously empty', () => {
    expect(violation.length).toBeGreaterThan(0);
    expect(surpriseGate()).toBe('seam:<lane>');
    expect(seamLanes()).toContain('audit');
    expect(auditNextStep()).toContain('pleach audit');
  });

  test('the `seam-violation` row names every field its appends carry', () => {
    const fieldsCell = rowCells(documented.get('seam-violation') ?? '')[2] ?? '';
    const unnamed = [...lineFields(violation).keys()].filter(
      (f) => !fieldsCell.includes(`\`${f}\``),
    );
    expect(documented.has('seam-violation')).toBe(true);
    expect(unnamed).toEqual([]);
  });

  test('the kinds table pins `seam-violation` as a node lifecycle event', () => {
    expect(KINDS['seam-violation']).toBe('node.lifecycle');
  });

  test('the `verdict` row names the gate a surprise settles under, its lanes and its next step', () => {
    const row = documented.get('verdict') ?? '';
    const facts = [`\`${surpriseGate()}\``, ...seamLanes().map((l) => `\`${l}\``), auditNextStep()];
    expect(facts.filter((fact) => !row.includes(fact))).toEqual([]);
    expect(unsaid(row, surpriseGate(), ['re-run', 'quarantine/<id>', 'D23'])).toEqual([]);
  });
});

describe('docs/adapters.md — the runner contract (D23)', () => {
  const md = readFileSync(ADAPTERS_DOC, 'utf8');
  const reasons = contractReasons();
  const rows = tableRows(md);

  test('the contract is read from its fixture, not vacuously empty', () => {
    expect(reasons.length).toBe(9);
  });

  test('the doc cites contracts/runner.md and says the reason is read whatever the exit code', () => {
    expect(unsaid(md, 'contracts/runner.md', ['whatever the exit code', 'reason'])).toEqual([]);
  });

  test('a table names each reason of the contract with its exit code and its class', () => {
    const wrong = reasons
      .filter(({ reason, exitCode, classification }) => {
        const cells = rows.get(`\`${reason}\``);
        return (
          cells === undefined ||
          !cells.some((c) => c === String(exitCode) || c === `\`${exitCode}\``) ||
          !cells.some((c) => says(c, classification))
        );
      })
      .map(({ reason, exitCode, classification }) => `${reason} (${exitCode}, ${classification})`);
    expect(wrong).toEqual([]);
  });

  test("the `WorkerResult` block lists the contract's reasons", () => {
    expect(documentedUnion(md)).toEqual(reasons.map(({ reason }) => reason).sort());
  });
});
