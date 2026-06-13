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

// buildAuditPrompt wraps the deterministic audit `command` in instructions that
// force the (stochastic) auditor to surface its result where the parser looks.
// The bare command alone leaves the `tend-audit-result` block in the tool's
// stdout while the agent replies with a prose summary — extractAuditJson reads
// the agent's MESSAGE, so it finds nothing ("egress unparseable", the defect the
// P6 proof named). The auditor must reproduce the block verbatim in its reply.
// Pairs with extractAuditJson: this module owns both halves of the egress
// contract — elicit the block, then parse it.
export function buildAuditPrompt(command: string): string {
  return [
    'Run this exact command in your shell and report its result:',
    '',
    command,
    '',
    `The command prints a fenced \`\`\`${FENCE_LABEL} block to stdout. Reproduce that block`,
    'in your reply VERBATIM — character for character, both fences included — as the final',
    'content of your message. Do not summarize, re-judge, reformat, truncate, or wrap it.',
    'Your reply is parsed by a machine that reads only that block; a summary or paraphrase',
    'fails the audit. If the command errors and prints no such block, say so and paste the',
    'complete error output instead.',
  ].join('\n');
}
