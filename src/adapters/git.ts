import { LedgerError } from '../core/errors.ts';
import type { Verdict } from '../core/plan.ts';
import type { LedgerSeam } from '../loop/deps.ts';
import { exec } from '../seams/exec.ts';

// ── gitLedger ─────────────────────────────────────────────────────────────────
//
// A LedgerSeam backed by git itself. readClosed lists pleach's published
// node/* branches in the repo (the branch SHA is the durable resume base).
// emitVerdict is PURE — it returns { closed: verdict.status === 'done' }.
// The "commit before emit" invariant means pleach has already published the
// branch before calling this; the ledger only confirms the decision.
//
// repo defaults to '.' when not provided.

export interface GitLedgerOpts {
  repo?: string;
}

export function gitLedger(opts: GitLedgerOpts = {}): LedgerSeam {
  const repo = opts.repo ?? '.';

  async function readClosed(_source: string): Promise<Map<string, string | null>> {
    // List all node/* branches with their commit SHAs.
    // The --format arg with its embedded space is ONE element — no shell, no splitting.
    const result = await exec(
      ['git', 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/node/'],
      { cwd: repo },
    );

    if (result.exitCode !== 0) {
      throw new LedgerError(`git for-each-ref exited ${result.exitCode}: ${result.output.trim()}`);
    }

    const map = new Map<string, string | null>();
    for (const line of result.output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      // Each line: "node/<id> <sha>"
      const spaceIdx = trimmed.indexOf(' ');
      if (spaceIdx === -1) continue;
      const ref = trimmed.slice(0, spaceIdx); // "node/<id>"
      const sha = trimmed.slice(spaceIdx + 1); // "<sha>"
      // Strip the "node/" prefix to get the bare node id.
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
