// ledger: D37
// issue #107 — a secret in a worker's output never reaches disk. Agent text
// reaches pleach's records in two places: the journal (a blocked node's
// `blockedReason`, a gate's output tail) and the artifacts kept beside a
// receipt (the handback, the friction journal, a findings log). Both are
// redacted through the injected redactor before they are written: the loop
// redacts the artifacts it keeps, and the journal seam — mirrored faithfully
// here by the harness — redacts every string of every line it serialises.
//
// The harness redactor replaces one planted fake secret with `[REDACTED]` and
// leaves everything else alone, so this test asserts the byte-level guarantee:
// the secret is gone, and the shape of the text around it is intact.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { FAKE_SECRET, type Harness, makeHarness, stop } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };

function plan() {
  return PlanSchema.parse({
    goal: 'g',
    source: 's',
    nodes: [{ id: 'x', work: { prompt: 'build x' }, policy: { maxAttempts: 1 } }],
  });
}

// A worker that ends blocked at a prompt whose text carries the fake secret,
// and whose final message (kept as the handback) carries it too. One node, one
// secret, two sinks: the journal's blockedReason and the handback artifact.
function secretHarness(): Harness {
  return makeHarness({
    waitScript: (ctx) =>
      ctx.role === 'audit'
        ? stop()
        : stop({
            reason: 'input',
            message: `approval prompt leaked: ${FAKE_SECRET}`,
            finalMessage: `built x, token ${FAKE_SECRET}`,
          }),
  });
}

// The kept handback bytes: the store writes both the close's own name and the
// latest; the harness mirrors both, and either holds the redacted message.
function handbackBytes(h: Harness): string[] {
  return [...h.artifacts.entries()]
    .filter(([path]) => path.endsWith('.handback.md'))
    .map(([, bytes]) => bytes);
}

describe('agent text is redacted before it reaches disk (issue #107)', () => {
  test('a secret in the handback and the blockedReason is replaced with [REDACTED]', async () => {
    const h = secretHarness();
    const summary = await runPlan(plan(), h.deps, OPTS);

    expect(summary.blocked).toEqual(['x']);

    // The journal: the blocked line's reason and the verdict's blockedReason
    // both carry the redacted prompt, never the secret.
    const blocked = h.journal.find((e) => e.event === 'blocked' && e.node === 'x');
    expect(String(blocked?.reason)).toContain('[REDACTED]');
    expect(String(blocked?.reason)).not.toContain(FAKE_SECRET);
    expect(String(blocked?.reason)).toContain('approval prompt leaked:');
    const verdict = h.journal.find((e) => e.event === 'verdict' && e.node === 'x');
    expect(String(verdict?.blockedReason)).toContain('[REDACTED]');
    expect(String(verdict?.blockedReason)).not.toContain(FAKE_SECRET);

    // The handback artifact: redacted bytes, the surrounding text intact.
    const kept = handbackBytes(h);
    expect(kept.length).toBeGreaterThan(0);
    for (const bytes of kept) {
      expect(bytes).toContain('built x, token [REDACTED]');
      expect(bytes).not.toContain(FAKE_SECRET);
    }

    // The whole journal holds the secret nowhere.
    for (const event of h.journal) {
      expect(JSON.stringify(event)).not.toContain(FAKE_SECRET);
    }
  });

  test('run-start and the receipt record that redaction was on', async () => {
    const h = secretHarness();
    await runPlan(plan(), h.deps, OPTS);

    expect(h.journal.find((e) => e.event === 'run-start')?.redaction).toBe('plotplot');
    expect(h.receipts.get('x')?.facts.redaction).toBe('plotplot');
  });

  test('an explicit opt-out records redaction: off on run-start and the receipt', async () => {
    const h = secretHarness();
    await runPlan(plan(), h.deps, { ...OPTS, redaction: 'off' });

    expect(h.journal.find((e) => e.event === 'run-start')?.redaction).toBe('off');
    expect(h.receipts.get('x')?.facts.redaction).toBe('off');
  });
});
