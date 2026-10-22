import { RedactError } from './errors.ts';
// Secret redaction, the pure half. Agent- and gate-produced text reaches the
// journal, the run log and the receipt's handback; a secret in any of it must
// never reach disk. The I/O half (running `plotplot redact`) is a seam
// (src/seams/redact.ts); this file is the traversal that applies a redactor to
// every string a value holds, so the seam and the test harness share one
// definition of "redact this object".

// Which redaction a run recorded. `off` is the explicit `--no-redact` opt-out;
// `plotplot` names the shared redactor pleach runs. It is a fact on every
// receipt and on the run-start line, so a run that wrote without redaction is
// always visible.
export type Redaction = 'off' | 'plotplot';

// A redactor: text in, text with every secret replaced by `[REDACTED]` out.
// The seam's real implementation spawns `plotplot redact`; the test harness
// replaces a fixed fake-secret pattern. Both honour this contract.
export type RedactText = (text: string) => Promise<string>;

// The line that separates a value's strings in the one text the redactor sees.
// Low-entropy and in no secret format, so a redactor leaves it alone.
const BOUNDARY = '\n--- pleach redact boundary ---\n';

function collect(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const v of value) collect(v, into);
  else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) collect(v, into);
  }
}

function rebuild(value: unknown, next: () => string): unknown {
  if (typeof value === 'string') return next();
  if (Array.isArray(value)) return value.map((v) => rebuild(v, next));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = rebuild(v, next);
    return out;
  }
  return value;
}

// Every string under `value` passed through `redact`, in ONE call: the real
// redactor is a process, and a journal line holds a dozen strings (D37). The
// strings are joined with a boundary line and split back; a result that does
// not split into as many strings fails closed, never writing what it could not
// place. Pure and total apart from the injected redactor.
export async function redactStrings(value: unknown, redact: RedactText): Promise<unknown> {
  const strings: string[] = [];
  collect(value, strings);
  if (strings.length === 0) return value;
  const parts = (await redact(strings.join(BOUNDARY))).split(BOUNDARY);
  if (parts.length !== strings.length) {
    throw new RedactError(
      'redact',
      `the redacted text came back as ${parts.length} part(s) for ${strings.length} string(s)`,
    );
  }
  let k = 0;
  return rebuild(value, () => parts[k++] as string);
}
