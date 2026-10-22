import type { Verdict } from './plan.ts';

// The account of a verdict that settled away from progress (issue #106): every
// non-`done` verdict must carry a non-empty `reason` and a non-empty
// `nextStep`, both derived from what the loop observed — the phase that
// stalled, the runner's last status, the tail of the worker's output — never a
// `?` and never null. This is a pure, total function: any combination of the
// optional facts below yields two non-empty strings, and when the facts are
// thin it says what is known (status, attempts, "the runner reported no
// reason").

export interface AccountFacts {
  node: string;
  status: Exclude<Verdict['status'], 'done'>;
  attempts: number;
  provider: string;
  // The failing gate's own record — `ran` names the command or the lane.
  gate?: { ran: string; exitCode: number };
  // The failing gate's output, already capped at the source.
  gateOutputTail?: string;
  // The blocking prompt's text, when the runner recorded one.
  blockedReason?: string;
  // The loop's own detail (a gate that could not run, an attempt left unspent,
  // a surprise's lane and next step).
  detail?: string;
  // What the runner saw at an abnormal end, when it could see anything.
  paneTail?: string;
  processExit?: number;
  // The step the loop already named when it settled the node (the audit's
  // re-adjudication, a surprise's next step). Taken as given when present.
  nextStep?: string;
}

export interface Account {
  reason: string;
  nextStep: string;
}

// A reason is for a human reading the journal, never a transcript: cap the
// text carried from a field, so an unruly worker cannot flood the line.
const REASON_CAP = 2000;
const TAIL_CAP = 400;

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim();
}

function capped(v: string | undefined, n: number): string {
  const t = trimmed(v);
  return t.length <= n ? t : t.slice(-n);
}

function present(v: string | undefined): v is string {
  return v !== undefined && v.trim() !== '';
}

function buildReason(f: AccountFacts): string {
  const gate = f.gate !== undefined ? `'${f.gate.ran}' failed (exit ${f.gate.exitCode})` : '';
  switch (f.status) {
    case 'blocked': {
      if (present(f.blockedReason)) return capped(f.blockedReason, REASON_CAP);
      const seen = present(f.paneTail)
        ? `the runner's last pane was:\n${capped(f.paneTail, TAIL_CAP)}`
        : f.processExit !== undefined
          ? `the runner's process exited ${f.processExit}`
          : 'the runner reported no blocking prompt';
      return `worker blocked after ${f.attempts} attempt(s), and no reason was recorded — ${seen}`;
    }
    case 'failed': {
      // The loop's own detail is richer than a bare gate: a gate that could not
      // run names whose fault it is, a surprise names the lane and next step.
      if (present(f.detail)) return capped(f.detail, REASON_CAP);
      if (gate !== '') {
        const tail = present(f.gateOutputTail) ? `\n${capped(f.gateOutputTail, TAIL_CAP)}` : '';
        return `${gate}${tail}`;
      }
      return `failed after ${f.attempts} attempt(s) — the runner reported no reason`;
    }
    case 'dead': {
      const base = `the worker died after ${f.attempts} attempt(s) — ${f.provider} is gone, not the work`;
      return present(f.detail) ? `${base}: ${capped(f.detail, TAIL_CAP)}` : base;
    }
    case 'timeout':
      return `the attempt ran out of time after ${f.attempts} attempt(s)`;
    case 'rejected':
      return present(f.detail)
        ? capped(f.detail, REASON_CAP)
        : `rejected after ${f.attempts} attempt(s)`;
    case 'aborted':
      return `the run was halted mid-wait after ${f.attempts} attempt(s) — the node did not lose`;
  }
}

function buildNextStep(f: AccountFacts): string {
  if (present(f.nextStep)) return f.nextStep.trim();
  switch (f.status) {
    case 'blocked': {
      // A spawn the provider refused for a sign-in (issue #128) already names
      // its next step inside blockedReason; say it again on the dedicated field.
      if (present(f.blockedReason) && /sign in/i.test(f.blockedReason)) {
        return `sign in to ${f.provider} once, outside the conductor, then re-run`;
      }
      return `resolve what the reason names, then re-run — the node resumes from quarantine/${f.node}`;
    }
    case 'dead':
      return `re-cast the node on another provider (--fallback-provider), or re-run once ${f.provider} is back`;
    case 'timeout':
      return 're-run with a longer --timeout-ms, or split the node';
    case 'aborted':
      return `re-run — the node resumes from quarantine/${f.node}`;
    case 'rejected':
      return `re-run — the node resumes from quarantine/${f.node}`;
    case 'failed': {
      if (present(f.detail) && /cannot run/.test(f.detail)) {
        return /the plan's/.test(f.detail)
          ? 'fix the plan — no attempt can run the gate'
          : 'fix the environment — no attempt can run the gate';
      }
      return `re-run — the node resumes from quarantine/${f.node}`;
    }
  }
}

export function account(f: AccountFacts): Account {
  return { reason: buildReason(f), nextStep: buildNextStep(f) };
}
