// Shared helper for tests that assert on lines the REAL journal seam wrote.
//
// Every line carries the friction profile's envelope beside the event's own
// fields (ledger D15). A test whose subject is the event — what was kept, what
// order things happened in — reads the event back through `ownFields` and goes
// on asserting exact equality on it, so an unexpected field is still a
// failure. The envelope itself is pinned in test/integration/journal-envelope
// and its unit siblings, which is the one place it should be.
const ENVELOPE_KEYS = new Set([
  'time',
  'event.name',
  'plotplot.kind',
  'plotplot.count',
  'plotplot.harness',
  'gen_ai.conversation.id',
  'plotplot.node',
  'plotplot.gate',
  'plotplot.runner',
  'gen_ai.request.model',
]);

/** A journal line minus the envelope: the fields the loop itself appended. */
export function ownFields(line: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(line).filter(([key]) => !ENVELOPE_KEYS.has(key)));
}
