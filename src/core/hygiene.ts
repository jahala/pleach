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
  [/(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}/, 'Stripe secret key'],
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'signed JWT'],
  [
    /(?:api[_-]?key|secret|password)["']?\s*[:=]\s*["'][A-Za-z0-9+/]{32,}["']/i,
    'inline credential assignment',
  ],
];

interface DocumentedExample {
  stamp: string;
  tail: string;
  source: string; // the vendor's public page that prints it
}

// The credentials vendors print in their own documentation so a reader can
// follow the page (D19). No issuer honours one and a commit carrying one has
// nothing to rotate, so a test quoting one is a test. Each is kept as the stamp
// an issuer puts on the front and the tail behind it: this repo gates its own
// diffs with this battery, so no file here carries one whole. Reference list:
// weeder's X1 `PUBLISHED` (src/core/rules/check/x1.rs); nothing is imported
// from it. Exact strings, never a pattern — one character away from an example
// is a credential like any other.
export const DOCUMENTED_EXAMPLE_CREDENTIALS: readonly DocumentedExample[] = [
  // AWS, "Manage access keys for IAM users": the example access key id.
  {
    stamp: 'AKIA',
    tail: 'IOSFODNN7EXAMPLE',
    source: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html',
  },
  // The same page: the secret access key paired with it.
  {
    stamp: 'wJalrXUtnFEMI',
    tail: '/K7MDENG/bPxRfiCYEXAMPLEKEY',
    source: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html',
  },
  // GitHub REST API, "Revoke a list of credentials": the request example's
  // personal access token (classic).
  {
    stamp: 'ghp_',
    tail: '1234567890abcdef1234567890abcdef12345678',
    source: 'https://docs.github.com/en/rest/credentials/revoke',
  },
  // The same request example: its fine-grained personal access token.
  {
    stamp: 'github_pat_',
    tail: '0A1B2C3D4E5F6G7H8I9J0K_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456',
    source: 'https://docs.github.com/en/rest/credentials/revoke',
  },
  // Stripe API reference, "Authentication": the test-mode secret key it shows.
  {
    stamp: 'sk_test_',
    tail: '4S68v29DeKcE4RxJcrJnUn5s',
    source: 'https://docs.stripe.com/api/authentication',
  },
  // Stripe, "Forward card details to third-party API endpoints": the test-mode
  // secret key its older guides print.
  {
    stamp: 'sk_test_',
    tail: '4eC39HqLyjWDarjtT1zdp7dc',
    source: 'https://docs.stripe.com/payments/vault-and-forward',
  },
];

const DOCUMENTED_EXAMPLES: ReadonlySet<string> = new Set(
  DOCUMENTED_EXAMPLE_CREDENTIALS.map((e) => e.stamp + e.tail),
);

// A run of the characters a credential is written in. The allowlist compares
// the whole run, never a match inside it: a token that merely begins with an
// example is not the example.
const CREDENTIAL_RUN = /[A-Za-z0-9+/=_-]+/g;

// The added line with every documented example blanked out, so each detector
// still reads whatever else the line carries.
function withoutDocumentedExamples(added: string): string {
  return added.replace(CREDENTIAL_RUN, (run) => (DOCUMENTED_EXAMPLES.has(run) ? '' : run));
}

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
    const added = withoutDocumentedExamples(line.slice(1));
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(added)) {
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
