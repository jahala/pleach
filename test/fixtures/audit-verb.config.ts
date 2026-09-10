import { gitLedger } from 'pleach/adapters/git';
import { scriptedAuditResult, scriptedRunner } from 'pleach/adapters/scripted';
import type { PleachConfig } from 'pleach/config';

// The cast for test/e2e/audit-verb.test.ts (ledger D17). One config, three
// relays: PLEACH_TEST_AUDIT_RELAY picks what the codex auditor hands back on
// THIS invocation — prose with no fenced block ('garbage', the relay defect
// that fails a node whose build was green), a passing fence, or a failing one.
// The run and the `pleach audit` that re-adjudicates it are separate
// processes, so the same repo meets a different auditor each time.
//
// The builder stamps the relay it built under into app.txt. Only a re-spawned
// builder can change that stamp, so a close whose app.txt still reads
// relay=garbage is the proof that the audit verb re-ran the audit alone and
// seeded its tree from the quarantine.

type Relay = 'garbage' | 'pass' | 'fail';

function relay(): Relay {
  const value = process.env.PLEACH_TEST_AUDIT_RELAY;
  return value === 'pass' || value === 'fail' ? value : 'garbage';
}

// A plausible auditor reply with no fenced block anywhere in it — the shape the
// P6 proof met: the agent ran the command, read the result, and summarized.
export const AUDITOR_PROSE = [
  'I ran the audit command you gave me and read its output.',
  '',
  'Everything looks fine to me: the checks pass and the tests are green, so',
  'I would call this one verified.',
].join('\n');

const AUDITOR: Record<Relay, string> = {
  garbage: AUDITOR_PROSE,
  pass: scriptedAuditResult([{ check: 'app', verdict: 'pass' }]),
  fail: scriptedAuditResult([
    { check: 'app', verdict: 'fail', reasons: ['app.txt does not do the thing'] },
  ]),
};

export default {
  runner: scriptedRunner([
    { provider: 'codex', message: AUDITOR[relay()] },
    {
      provider: 'claude',
      prompt: 'build the app',
      files: { 'app.txt': `built (relay=${relay()})\n` },
      message: 'wrote app.txt',
    },
    {
      provider: 'claude',
      prompt: 'build the flaky thing',
      files: { 'flaky.txt': 'half done\n' },
      message: 'wrote flaky.txt',
    },
  ]),
  ledger: gitLedger(),
} satisfies PleachConfig;
