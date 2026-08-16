import { LedgerError } from '../core/errors.ts';
import type { Verdict } from '../core/plan.ts';
import type { LedgerSeam } from '../loop/deps.ts';
import { exec } from '../seams/exec.ts';

// ── gitLedger ─────────────────────────────────────────────────────────────────
//
// A LedgerSeam backed by git itself. readClosed lists pleach's published
// node/* branches in the repo (the branch SHA is the durable resume base),
// SCOPED to the given plan source: run-plan writes `source: <plan.source>`
// into every node commit's body, and only branches whose tip carries that
// exact line count. Two plans sharing one repo therefore cannot cross-resume
// from each other's work, and a hand-made node/* branch (no source line) is
// never treated as verified — fail closed.
// emitVerdict is PURE — it returns { closed: verdict.status === 'done' }.
// The "commit before emit" invariant means pleach has already published the
// branch before calling this; the ledger only confirms the decision.
//
// repo defaults to '.' when not provided.

export interface GitLedgerOpts {
  repo?: string;
}

// for-each-ref record/field separators (%xx hex escapes): fields split on NUL,
// records on SOH — the commit body may contain newlines, so line-parsing won't do.
const FIELD_SEP = '\x00';
const RECORD_SEP = '\x01';

export function gitLedger(opts: GitLedgerOpts = {}): LedgerSeam {
  const repo = opts.repo ?? '.';

  async function readClosed(source: string): Promise<Map<string, string | null>> {
    // List all node/* branches with their SHAs and tip-commit bodies.
    // The --format arg is ONE element — no shell, no splitting.
    const result = await exec(
      [
        'git',
        'for-each-ref',
        '--format=%(refname:short)%00%(objectname)%00%(contents:body)%01',
        'refs/heads/node/',
      ],
      { cwd: repo },
    );

    if (result.exitCode !== 0) {
      throw new LedgerError(`git for-each-ref exited ${result.exitCode}: ${result.output.trim()}`);
    }

    const sourceLine = `source: ${source}`;
    const map = new Map<string, string | null>();
    for (const record of result.output.split(RECORD_SEP)) {
      const fields = record.split(FIELD_SEP);
      if (fields.length < 3) continue;
      const ref = (fields[0] as string).trim(); // "node/<id>"
      const sha = (fields[1] as string).trim();
      const body = fields[2] as string;
      if (ref === '' || sha === '') continue;
      // Only branches this plan's runs published: exact source line in the body.
      if (!body.split('\n').some((l) => l.trim() === sourceLine)) continue;
      const id = ref.startsWith('node/') ? ref.slice('node/'.length) : ref;
      map.set(id, sha);
    }

    return map;
  }

  async function emitVerdict(verdict: Verdict, _source: string): Promise<{ closed: boolean }> {
    return { closed: verdict.status === 'done' };
  }

  return { readClosed, emitVerdict };
}
