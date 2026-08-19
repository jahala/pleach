// The hygiene gate (§E) — pure scans over the staged diff, run after scoped
// staging and before smoke. Three detectors, three real incident classes:
// "verified but did nothing" (empty-diff on agent work), "verified but
// leaking" (credentials in added lines), "verified but destructive" (a file
// mostly deleted without the worker saying so). High precision over recall —
// a noisy gate gets disabled by its users, which is worse than a narrow one.
// All failures are retryable with evidence; run-node owns routing.

export interface HygieneInput {
  workKind: 'prompt' | 'phases' | 'command';
  stagedFiles: readonly string[];
  diff: string; // the staged diff text
  numstat: readonly { file: string; added: number; deleted: number }[];
  finalMessage: string; // the worker's final message (deletion re-statement lives here)
}

export interface HygieneFailure {
  kind: 'empty-diff' | 'secret' | 'deletion';
  evidence: string;
}

// ~12 high-signal patterns. Precision over recall: each of these is a
// near-certain credential, not a maybe. Scanned over ADDED lines only —
// removing a secret must never be punished.
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key id'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/, 'private key block'],
  [/ghp_[A-Za-z0-9]{36}/, 'GitHub personal access token'],
  [/github_pat_[A-Za-z0-9_]{22,}/, 'GitHub fine-grained token'],
  [/sk-ant-[A-Za-z0-9-]{20,}/, 'Anthropic API key'],
  [/sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/, 'OpenAI API key'],
  [/xox[bpoas]-[0-9A-Za-z-]{10,}/, 'Slack token'],
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/glpat-[A-Za-z0-9_-]{20}/, 'GitLab token'],
  [/npm_[A-Za-z0-9]{36}/, 'npm token'],
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'signed JWT'],
  [
    /(?:api[_-]?key|secret|password)["']?\s*[:=]\s*["'][A-Za-z0-9+/]{32,}["']/i,
    'inline credential assignment',
  ],
];

const DELETION_PCT = 0.5;
const DELETION_FLOOR = 100; // lines — both thresholds must trip

export function checkDiffHygiene(input: HygieneInput): HygieneFailure | null {
  // 1 — empty-diff attribution: agent work that claims done on nothing.
  // Command work may legitimately be effect-free (probes, verifications).
  if (input.workKind !== 'command' && input.stagedFiles.length === 0) {
    return {
      kind: 'empty-diff',
      evidence:
        'your attempt produced no changes — an agent node cannot claim done on nothing. ' +
        'If no change is needed, run the gate so its stamp lands in your diff.',
    };
  }

  // 2 — secrets in ADDED lines, attributed to their file via the diff headers.
  let currentFile = '?';
  for (const line of input.diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice('+++ b/'.length);
      continue;
    }
    if (!line.startsWith('+')) continue;
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        return {
          kind: 'secret',
          evidence:
            `${label} detected in ${currentFile} — remove the credential and reference it ` +
            `via an environment variable or secret store instead; committed secrets are ` +
            `compromised the moment they land.`,
        };
      }
    }
  }

  // 3 — the deletion tripwire: one file losing most of itself, in bulk,
  // without the worker saying so. The escape is deterministic: re-state the
  // deletion in the final message (any mention of the file alongside a
  // deletion word) and the wire passes.
  for (const n of input.numstat) {
    const total = n.added + n.deleted;
    if (n.deleted > DELETION_FLOOR && total > 0 && n.deleted / total > DELETION_PCT) {
      const restated =
        input.finalMessage.includes(n.file) &&
        /delet|remov|rewrit|replac/i.test(input.finalMessage);
      if (!restated) {
        return {
          kind: 'deletion',
          evidence:
            `${n.file} loses ${n.deleted} lines (${Math.round((n.deleted / total) * 100)}% of ` +
            `its diff) — if intentional, re-state it in your final message naming the file ` +
            `and the deletion; unexplained bulk deletion does not publish.`,
        };
      }
    }
  }

  return null;
}
