// Is this gate's stdout a findings log?  (ledger D14, jahala/pleach#59)
//
// When the smoke is `weeder check --strict --format sarif`, its stdout is a
// SARIF 2.1.0 log whose `suppressions` are the only record of what an agent
// waved through in that node — the one thing worth keeping past dispose, and
// what `gates[].artifactSha` hashes. Every other smoke prints something else
// and keeps nothing, so the recognition must be exact: a version this code
// has not read the spec for is not a log it can promise anything about.
//
// Total by construction. This runs inside a gate that has ALREADY passed, on
// bytes a worker's command chose; a throw here would fail a finished node for
// the shape of its own output. Every refusal is the same answer — null — and
// the caller's only question is whether there is a log, never why not.
//
// The runs stay `unknown`: pleach hashes and keeps the bytes, it does not read
// findings. Whoever counts rules later validates what it needs.

export interface SarifLog {
  version: '2.1.0';
  runs: unknown[];
}

export function parseSarif(text: string): SarifLog | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Dropping this is the whole point: "stdout is not JSON" is an ANSWER
    // here, not a failure. Most smokes print test output, and the parse error
    // says nothing the caller could act on.
    return null;
  }
  // A SARIF log is a JSON object. `typeof null` is 'object', and an array
  // parses as one too — neither can be a log.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const log = value as { version?: unknown; runs?: unknown };
  if (log.version !== '2.1.0' || !Array.isArray(log.runs)) return null;

  // A fresh literal: whatever else the document carried ($schema, a
  // `__proto__` key) stays out of what the gate hands on.
  return { version: '2.1.0', runs: log.runs };
}
