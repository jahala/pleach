// issue #115 — the pure half of `pleach clean`'s session sweep. From the run
// journal's lines, which sessions the loop spawned and never killed or reaped:
// a crash leaves a `worker-spawned` with no `worker-killed` (or
// `worker-reaped`) after it, and that session is the one still burning a seat.
//
// Pure and total: no I/O, the input is never mutated, and a line that is not
// one of the three session events — or carries no `session` — is skipped, never
// thrown on. A session spawned, killed, and spawned again is unreaped when the
// later spawn has no later kill: the LAST event for a session decides.

export interface UnreapedSession {
  node: string;
  session: string;
}

export function unreapedSessions(lines: readonly Record<string, unknown>[]): UnreapedSession[] {
  // session name → the node of its latest spawn and whether that spawn is still
  // standing. Insertion order is first-spawn order, which is the answer's order.
  const sessions = new Map<string, { node: string; alive: boolean }>();
  for (const line of lines) {
    const event = line.event;
    const session = typeof line.session === 'string' ? line.session : undefined;
    if (session === undefined) continue;
    if (event === 'worker-spawned' && typeof line.node === 'string') {
      sessions.set(session, { node: line.node, alive: true });
    } else if (event === 'worker-killed' || event === 'worker-reaped') {
      const state = sessions.get(session);
      if (state !== undefined) state.alive = false;
    }
  }
  const out: UnreapedSession[] = [];
  for (const [session, state] of sessions) {
    if (state.alive) out.push({ node: state.node, session });
  }
  return out;
}
