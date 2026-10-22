// issue #106 — every non-progress verdict carries a non-empty reason and a
// non-empty nextStep, derived from what the loop observed. `account` is the
// pure, total function that computes the pair: any combination of the optional
// facts yields two non-empty strings, never `?`, never null.
import { describe, expect, test } from 'bun:test';
import { type AccountFacts, account } from '../../src/core/account.ts';

function facts(over: Partial<AccountFacts> & { status: AccountFacts['status'] }): AccountFacts {
  return { attempts: 1, provider: 'claude', ...over };
}

describe('account — every non-progress status yields two non-empty strings', () => {
  const statuses: AccountFacts['status'][] = [
    'failed',
    'dead',
    'timeout',
    'rejected',
    'aborted',
    'blocked',
  ];

  test('each status accounts for itself', () => {
    for (const status of statuses) {
      const a = account(facts({ status }));
      expect(a.reason.length, `reason for ${status}`).toBeGreaterThan(0);
      expect(a.nextStep.length, `nextStep for ${status}`).toBeGreaterThan(0);
    }
  });
});

describe('account — failed', () => {
  test('a gate that failed in the ordinary way names the gate and the exit code', () => {
    const a = account(
      facts({ status: 'failed', gate: { ran: 'false', exitCode: 1 }, gateOutputTail: 'boom' }),
    );
    expect(a.reason).toContain('false');
    expect(a.reason).toContain('1');
    expect(a.reason).toContain('boom');
    expect(a.nextStep).toContain('re-run the plan');
  });

  test('a gate that could not run names whose fault it is, and the next step fixes it', () => {
    const a = account(
      facts({
        status: 'failed',
        gate: { ran: 'nope', exitCode: 127 },
        detail:
          'the environment cannot run the gate; fix the environment, no attempt can: missing nope',
      }),
    );
    expect(a.reason).toContain('cannot run');
    expect(a.nextStep).toContain('fix the environment');
  });

  test('only the audit lane throwing points at a re-audit, not a rebuild', () => {
    const a = account(
      facts({
        status: 'failed',
        gate: { ran: 'seam:audit', exitCode: -1 },
        detail: 'wait exploded — next: pleach audit <plan.json> n',
        nextStep: 'pleach audit <plan.json> n',
      }),
    );
    expect(a.nextStep).toBe('pleach audit <plan.json> n');
  });

  test('thin facts still say what is known', () => {
    const a = account(facts({ status: 'failed', attempts: 2 }));
    expect(a.reason).toContain('2');
    expect(a.reason.length).toBeGreaterThan(0);
  });
});

describe('account — blocked', () => {
  test('a recorded blockedReason rides the verdict verbatim', () => {
    const a = account(facts({ status: 'blocked', blockedReason: 'need a key' }));
    expect(a.reason).toBe('need a key');
    expect(a.nextStep).toContain('resolve what the reason names');
  });

  test('a spawn refused for a sign-in names the sign-in as the next step', () => {
    const a = account(
      facts({
        status: 'blocked',
        blockedReason: 'Sign in to claude once, outside the conductor, then re-run.',
      }),
    );
    expect(a.nextStep).toContain('sign in');
    expect(a.nextStep).toContain('claude');
  });

  test('a blocked node with no recorded reason says what was observed', () => {
    const a = account(facts({ status: 'blocked', attempts: 1 }));
    expect(a.reason).toContain('no reason');
    expect(a.nextStep).toContain('re-run the plan');
  });
});

describe('account — the other terminal statuses', () => {
  test('dead names the provider as the cause, not the work', () => {
    const a = account(facts({ status: 'dead', provider: 'codex' }));
    expect(a.reason).toContain('codex');
    expect(a.nextStep).toContain('--fallback-provider');
  });

  test('timeout names the clock and the fix', () => {
    const a = account(facts({ status: 'timeout', attempts: 1 }));
    expect(a.reason).toContain('out of time');
    expect(a.nextStep).toContain('--timeout-ms');
  });

  test('aborted says the node did not lose and points at a resume', () => {
    const a = account(facts({ status: 'aborted', attempts: 1 }));
    expect(a.reason).toContain('did not lose');
    expect(a.nextStep).toContain('re-run the plan');
  });

  test('rejected has a reason and a next step even with thin facts', () => {
    const a = account(facts({ status: 'rejected' }));
    expect(a.reason.length).toBeGreaterThan(0);
    expect(a.nextStep.length).toBeGreaterThan(0);
  });
});
