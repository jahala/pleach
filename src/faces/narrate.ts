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

export function narrateEvent(e: Record<string, unknown>): string | null {
  switch (e.event) {
    case 'run-start':
      return `pleach: running ${n(e.nodes)} node(s) — ${s(e.goal)}`;
    case 'node-start':
      return `▶ ${s(e.node)}: building`;
    case 'gate-fail':
      return `✗ ${s(e.node)}: ${s(e.gate)} gate failed`;
    case 'blocked':
      return `⚠ ${s(e.node)} NEEDS YOU — worker blocked: ${s(e.reason)}`;
    case 'verdict': {
      if (e.status === 'done') return null; // 'closed' narrates the publish
      return `✗ ${s(e.node)}: ${s(e.status)} after ${n(e.attempts)} attempt(s)`;
    }
    case 'closed':
      return `✓ ${s(e.node)}: published node/${s(e.node)} @ ${s(e.sha).slice(0, 7)}`;
    case 'not-closed':
      return `${s(e.node)}: ledger declined to close — branch published, not verified`;
    case 'quarantined':
      return `${s(e.node)}: failed work kept on ${s(e.branch)} for inspection`;
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
      return `landing verified work — ${s(e.goal)}`;
    case 'land-gate':
      return `land gate: ${len(e.commands)} check(s) on the merged stack`;
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
