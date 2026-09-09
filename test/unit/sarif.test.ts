// parseSarif — the smoke gate's stdout either IS a findings log or it is not,
// decided from the bytes alone.  ledger: D14 (jahala/pleach#59)
//
// When the smoke is `weeder check --strict --format sarif`, its stdout is a
// SARIF 2.1.0 log whose `suppressions` are the only record of what an agent
// waved through in that node. That log is what settle keeps beside the receipt
// and what `gates[].artifactSha` hashes; anything else keeps nothing and
// leaves the receipt byte-identical. So recognition has to be exact, and it
// has to be total: this runs inside a gate that has already passed, and a
// throw here would fail a node for the shape of its own output.
//
// The fixture is real output of `weeder check --strict --format sarif`
// (weeder 0.1.0), trimmed to two results, one of them suppressed.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseSarif } from '../../src/core/sarif.ts';

const WEEDER_SARIF = readFileSync(
  new URL('../fixtures/weeder-check.sarif', import.meta.url).pathname,
  'utf8',
);

const MINIMAL = '{"version":"2.1.0","runs":[]}';

const log = (body: Record<string, unknown>) => JSON.stringify(body);

describe('parseSarif — a SARIF 2.1.0 log is accepted with its runs', () => {
  test('real weeder output: the runs survive verbatim, suppressions included', () => {
    const parsed = parseSarif(WEEDER_SARIF);
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe('2.1.0');
    expect(parsed?.runs).toEqual(JSON.parse(WEEDER_SARIF).runs);

    const run = parsed?.runs[0] as { results: { ruleId: string; suppressions?: unknown[] }[] };
    expect(run.results.map((r) => r.ruleId)).toEqual(['S2', 'X1']);
    expect(run.results[1].suppressions).toHaveLength(1);
  });

  test('a gate that found nothing still printed a log', () => {
    const parsed = parseSarif(MINIMAL);
    expect(parsed?.version).toBe('2.1.0');
    expect(parsed?.runs).toEqual([]);
  });

  test("a command's stdout ends in a newline", () => {
    expect(parseSarif(`${WEEDER_SARIF}\n`)?.runs).toHaveLength(1);
  });

  test('unrecognised keys do not disqualify a log — SARIF carries more than we read', () => {
    const parsed = parseSarif(
      log({
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [{}],
      }),
    );
    expect(parsed?.runs).toEqual([{}]);
  });

  test('what is inside a run is not the question here', () => {
    const parsed = parseSarif(log({ version: '2.1.0', runs: [1, 'x', null] }));
    expect(parsed?.runs).toEqual([1, 'x', null]);
  });
});

describe('parseSarif — everything else is refused', () => {
  const refused: Record<string, string> = {
    // Not JSON at all — what an ordinary smoke command prints.
    'no output': '',
    'whitespace alone': '  \n\t\n',
    'a human-readable summary': 'weeder: 2 findings, 1 suppressed\n',
    'the output of a test runner': '12 pass\n0 fail\n',
    'a log cut off mid-stream': '{"version":"2.1.0","runs":[',
    'two logs concatenated': `${WEEDER_SARIF}${MINIMAL}`,
    // Why the exec seam has to report stdout on its own.
    'stderr interleaved ahead of the log': `warning: no weeder.toml found\n${WEEDER_SARIF}`,
    // JSON, but not an object.
    'the JSON null': 'null',
    'a bare number': '42',
    'a bare boolean': 'true',
    'a bare string': '"2.1.0"',
    'an array of logs': `[${WEEDER_SARIF}]`,
    // An object, but not a SARIF 2.1.0 log.
    'SARIF 2.0.0': log({ version: '2.0.0', runs: [] }),
    'a future SARIF': log({ version: '3.0.0', runs: [] }),
    'a truncated version': log({ version: '2.1', runs: [] }),
    'a pre-release of the version': log({ version: '2.1.0-rtm.5', runs: [] }),
    'no version at all': log({ runs: [] }),
    'a version that is not a string': log({ version: 2.1, runs: [] }),
    'a null version': log({ version: null, runs: [] }),
    'the version only on the run': log({ runs: [{ version: '2.1.0' }] }),
    // The version is right; `runs` is not an array.
    'no runs': log({ version: '2.1.0' }),
    'runs as an object': log({ version: '2.1.0', runs: {} }),
    'runs as null': log({ version: '2.1.0', runs: null }),
    'runs as a string': log({ version: '2.1.0', runs: 'one' }),
    'runs as a count': log({ version: '2.1.0', runs: 1 }),
    // A log, but not at the top level.
    'a log wrapped in an envelope': log({ sarif: { version: '2.1.0', runs: [] } }),
  };

  for (const [name, text] of Object.entries(refused)) {
    test(name, () => {
      expect(parseSarif(text)).toBeNull();
    });
  }
});

describe('parseSarif — total and pure', () => {
  // Whatever a smoke command can put on stdout, including bytes no parser
  // should meet. None of it may throw: the gate has already passed.
  const HOSTILE: readonly string[] = [
    '',
    '\0\0\0',
    '\u001b[31mred\u001b[0m',
    `\ufeff${MINIMAL}`,
    '{'.repeat(1000),
    `${'['.repeat(1000)}${']'.repeat(1000)}`,
    `{"version":"2.1.0","runs":[${'[],'.repeat(500)}[]]}`,
    '{"version":"2.1.0","runs":[],',
    "{'version':'2.1.0','runs':[]}",
    'NaN',
    'undefined',
    '"\\ud800"',
    '\u00ff\u00fe\u0000{',
    WEEDER_SARIF.slice(0, 500),
    WEEDER_SARIF.toUpperCase(),
    `${MINIMAL}\n${MINIMAL}\n`,
    'x'.repeat(100_000),
  ];

  test('no input can make it throw', () => {
    for (const text of HOSTILE) {
      expect(() => parseSarif(text)).not.toThrow();
    }
  });

  test('every answer is null or a log — there is no third shape', () => {
    for (const text of [...HOSTILE, WEEDER_SARIF, MINIMAL]) {
      const parsed = parseSarif(text);
      if (parsed === null) continue;
      expect(parsed.version).toBe('2.1.0');
      expect(Array.isArray(parsed.runs)).toBe(true);
    }
  });

  test('a key in the log cannot reach the prototype chain', () => {
    const parsed = parseSarif('{"version":"2.1.0","runs":[],"__proto__":{"pwned":true}}');
    expect(parsed?.runs).toEqual([]);
    expect(({} as Record<string, unknown>).pwned).toBeUndefined();
  });

  test('the same bytes give the same answer, and a caller cannot poison the next one', () => {
    const first = parseSarif(WEEDER_SARIF);
    first?.runs.push('mutated');

    const second = parseSarif(WEEDER_SARIF);
    expect(second?.runs).toHaveLength(1);
    expect(second?.runs).toEqual(JSON.parse(WEEDER_SARIF).runs);
  });
});
