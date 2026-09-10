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
      return `✗ ${s(e.node)}: ${s(e.status)} after ${n(e.attempts)} attempt(s)`;
    }
    case 'closed': {
      // degraded[] rides the close line — "no coverage is not coverage" must
      // be visible when the trust decision happens, not on later inspection.
      const line = `✓ ${s(e.node)}: published node/${s(e.node)} @ ${s(e.sha).slice(0, 7)}`;
      return len(e.degraded) > 0
        ? `${line} — degraded: ${(e.degraded as unknown[]).map(s).join(', ')}`
        : line;
    }
    case 'acceptance-changed':
      return `↻ ${s(e.node)}: acceptance changed since its close — re-dispatching (was verified against a different gate)`;
    case 'acceptance-cascade':
      return `↻ ${s(e.node)}: rebuilding — its base ${s(e.via)} was re-dispatched, so this close embeds stale work`;
    case 'not-closed':
      return `${s(e.node)}: ledger declined to close — branch published, not verified`;
    case 'quarantined':
      return `${s(e.node)}: unfinished or failed work kept on ${s(e.branch)} for inspection`;
    case 'quarantine-failed':
      return `${s(e.node)}: could not preserve failed work (${s(e.detail)})`;
    case 'rebuild-required':
      return `✗ ${s(e.node)}: verified branch moved since close — rebuild required`;
    case 'sha-mismatch':
      return `✗ ${s(e.node)}: branch does not match its recorded verification`;
    case 'run-end':
      return (
        `pleach: run complete — ${len(e.closed)} closed · ${len(e.failed)} failed · ` +
        `${len(e.skipped)} skipped · ${len(e.blocked)} blocked · ` +
        `${len(e.alreadyVerified)} already verified`
      );
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
    case 'landed':
      return `✓ landed ${s(e.ref ?? e.sha ?? '')}`.trim();
    default:
      return null; // diagnostic noise (dispose-failed, …) and future events
  }
}
