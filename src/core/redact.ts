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

// Every string under `value` passed through `redact`, arrays and objects
// walked in place. Pure and total: the redactor is the only thing that can
// fail, and it is injected.
export async function redactStrings(value: unknown, redact: RedactText): Promise<unknown> {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) out.push(await redactStrings(v, redact));
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = await redactStrings(v, redact);
    return out;
  }
  return value;
}
