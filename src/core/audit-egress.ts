import { AuditParseError } from './errors.ts';

// Extract the audit JSON the auditor emits as a fenced ```tend-audit-result
// block. The worker's finalMessage is read UNTRUNCATED (ledger C4) and may
// contain prose, several attempts, or other code fences — only the LAST block
// labelled exactly `tend-audit-result` is authoritative. Pure & total: every
// failure path is a typed throw carrying the raw message for the journal.

const FENCE_LABEL = 'tend-audit-result';

// Opening fence: a line that is ``` immediately followed by the label and
// nothing else (trailing whitespace tolerated). Closing fence: a line that is
// ``` and nothing else. Captures the content between them.
const BLOCK_RE = new RegExp(
  String.raw`\x60\x60\x60${FENCE_LABEL}[^\S\n]*\n([\s\S]*?)\n\x60\x60\x60`,
  'g',
);

export function extractAuditJson(finalMessage: string): unknown {
  let lastContent: string | null = null;
  for (const match of finalMessage.matchAll(BLOCK_RE)) {
    lastContent = match[1] ?? '';
  }

  if (lastContent === null) {
    throw new AuditParseError(finalMessage);
  }

  try {
    return JSON.parse(lastContent);
  } catch {
    throw new AuditParseError(finalMessage);
  }
}
