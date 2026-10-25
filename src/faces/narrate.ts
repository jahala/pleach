// narrateEvent — the W1 narration floor. Turns journal events into
// plain-language one-liners for stderr so a running plan is never a black box,
// even without tend2's richer watch surface. Blocked-on-human is the shout.
// Pure & total: unknown or diagnostic-only events return null (the journal
// file keeps everything; narration keeps what a human glances at).

function s(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '?');
}

function n(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function len(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

// The goal's first sentence is its identity; the rest is a paragraph the
// operator would otherwise re-read on every run AND every land (P6c).
function firstSentence(v: unknown): string {
  const text = s(v);
  const end = text.search(/\.(?:\s|$)|\n/);
  return end === -1 ? text : text.slice(0, end + 1);
}

// issue #130: one line when a run leaves verified work on no remote, nothing
// when it does not. No remote at all is its own fact, said instead of counted.
function runEndLocalOnlyWarning(localOnly: unknown): string | null {
  if (typeof localOnly !== 'object' || localOnly === null) return null;
  const lo = localOnly as { nodeBranches?: unknown; remotes?: unknown };
  if (n(lo.remotes) === 0) {
    return '⚠ the repository has no remote — nothing is pushed off this machine';
  }
  const count = len(lo.nodeBranches);
  if (count > 0) {
    return `⚠ ${count} verified node branch(es) exist only on this machine — push them to keep the work`;
  }
  return null;
}

// issue #130: one line when a landing left the branch off its upstream.
function landedLocalOnlyWarning(e: Record<string, unknown>): string | null {
  const lo = e.localOnly as { aheadOfUpstream?: unknown } | undefined;
  if (lo === undefined) return null;
  const ahead = lo.aheadOfUpstream;
  const branch = s(e.branch);
  if (ahead === null) {
    return `⚠ landed on '${branch}' — the branch has no upstream; push it to keep the work`;
  }
  if (typeof ahead === 'number' && ahead > 0) {
    return `⚠ landed on '${branch}', ${ahead} commit(s) ahead of its upstream — push to keep the work`;
  }
  return null;
}

export function narrateEvent(e: Record<string, unknown>): string | null {
  switch (e.event) {
    case 'run-start':
      return `pleach: running ${n(e.nodes)} node(s) — ${firstSentence(e.goal)}`;
    case 'node-start':
      return `▶ ${s(e.node)}: building`;
    case 'gate-fail':
      return `✗ ${s(e.node)}: ${s(e.gate)} gate failed`;
    case 'run-aborted':
      return 'run aborted by signal — no new launches; in-flight nodes settling';
    case 'run-stopped':
      return 'run stopped on request — no new launches; in-flight nodes finishing normally';
    case 'gate-flaky':
      return `${s(e.node)}: ${s(e.gate)} gate red once, green on retry — transient, proceeding`;
    case 'blocked':
      return `⚠ ${s(e.node)} NEEDS YOU — worker blocked: ${s(e.reason)}`;
    case 'verdict': {
      if (e.status === 'done') return null; // 'closed' narrates the publish
      // A non-progress verdict carries a computed reason and a next step
      // (issue #106); `detail` is the older journal-only spelling of the same
      // cause, still read for lines written before the account existed.
      const head = `✗ ${s(e.node)}: ${s(e.status)} after ${n(e.attempts)} attempt(s)`;
      const reason = typeof e.reason === 'string' ? e.reason.trim() : '';
      const why = reason !== '' ? reason : typeof e.detail === 'string' ? e.detail.trim() : '';
      const next = typeof e.nextStep === 'string' ? e.nextStep.trim() : '';
      const lines = [head];
      if (why !== '') lines.push(why);
      if (next !== '') lines.push(`next: ${next}`);
      return lines.join('\n');
    }
    case 'closed': {
      // degraded[] rides the close line — "no coverage is not coverage" must
      // be visible when the trust decision happens, not on later inspection.
      // issue #130: a close is a LOCAL branch, never "published" (which reads
      // as "out of this machine").
      const line = `✓ ${s(e.node)}: verified on local branch node/${s(e.node)} @ ${s(e.sha).slice(0, 7)}`;
      return len(e.degraded) > 0
        ? `${line} — degraded: ${(e.degraded as unknown[]).map(s).join(', ')}`
        : line;
    }
    case 'acceptance-changed':
      return `↻ ${s(e.node)}: acceptance changed since its close — re-dispatching (was verified against a different gate)`;
    case 'acceptance-cascade':
      return `↻ ${s(e.node)}: rebuilding — its base ${s(e.via)} was re-dispatched, so this close embeds stale work`;
    case 'not-closed':
      return `${s(e.node)}: ledger declined to close — local branch written, not verified`;
    case 'quarantined':
      return `${s(e.node)}: unfinished or failed work kept on ${s(e.branch)} for inspection`;
    case 'handback-read-failed':
      return `${s(e.node)}: could not read the worker's final message (read exited ${n(e.exitCode)}) — keeping a note in its place`;
    case 'local-only-check-failed':
      return `could not tell what exists only on this machine (${s(e.detail)})`;
    case 'quarantine-failed':
      return `${s(e.node)}: could not preserve failed work (${s(e.detail)})`;
    case 'rebuild-required':
      return `✗ ${s(e.node)}: verified branch moved since close — rebuild required`;
    case 'sha-mismatch':
      return `✗ ${s(e.node)}: branch does not match its recorded verification`;
    case 'run-end': {
      const base =
        `pleach: run complete — ${len(e.closed)} closed · ${len(e.failed)} failed · ` +
        `${len(e.skipped)} skipped · ${len(e.blocked)} blocked · ` +
        `${len(e.alreadyVerified)} already verified`;
      const warning = runEndLocalOnlyWarning(e.localOnly);
      return warning === null ? base : `${base}\n${warning}`;
    }
    case 'land-start':
      return `landing verified work — ${firstSentence(e.goal)}`;
    case 'land-setup':
      return `provisioning the stack: ${len(e.commands)} setup command(s)`;
    case 'land-setup-failed':
      return `✗ land refused: '${s(e.command)}' failed provisioning the stack — environment, not composition; no culprit`;
    case 'land-gate':
      return `land gate: ${len(e.commands)} check(s) on the merged stack`;
    case 'land-gate-refused': {
      // The tail rides the line: an operator who reads only stderr must see
      // WHY the gate said no, not just that it did.
      const why = s(e.outputTail).trim();
      const head = `✗ land refused by '${s(e.command)}' (exit ${n(e.exitCode)}) — nothing lands`;
      return why === '' ? head : `${head}\n${why}`;
    }
    case 'land-gate-retry':
      return `land gate red once — retrying ${s(e.command)} (flaky screen)`;
    case 'land-bisect':
      return `bisecting the stack to name the culprit…`;
    case 'land-culprit':
      return `✗ culprit: ${s(e.node)} — '${s(e.command)}' fails when it lands with the others`;
    case 'land-integrity-failed':
      return `✗ land diagnosis incoherent — the culprit-free stack also fails; nothing lands`;
    case 'land-blocked':
      return `✗ land refused: ${s(e.reason ?? e.unverified)}`;
    case 'land-conflict':
      return `✗ land conflict on ${s(e.ref)} — repository left untouched`;
    case 'land-merge-refused':
      return `✗ land refused on ${s(e.ref)}: git would not merge it — repository left untouched`;
    case 'landed': {
      const base = `✓ landed ${s(e.branch ?? e.sha ?? '')}`.trim();
      const warning = landedLocalOnlyWarning(e);
      return warning === null ? base : `${base}\n${warning}`;
    }
    default:
      return null; // diagnostic noise (dispose-failed, …) and future events
  }
}
