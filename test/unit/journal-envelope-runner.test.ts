// The verdict line's runner attributes — the half of the envelope that says
// who did the work.  ledger: D15 (jahala/pleach#60, jahala/plotplot#16)
//
// The profile names the runner, not the provider: cape-town's ruling
// (2026-09-08) is that `claude` → `anthropic` is a guess, because Claude Code
// can be routed through Bedrock or Vertex and pleach cannot see which. So the
// line carries `plotplot.runner` verbatim from the field the loop already
// resolved, `gen_ai.request.model` only when the plan pinned a model, and
// `gen_ai.provider.name` never.
import { describe, expect, test } from 'bun:test';
import { envelope, KINDS } from '../../src/core/journal-envelope.ts';

const CLOCK = new Date('2026-09-06T14:03:47.118Z');

/** A verdict event in the shape run-plan appends it: `provider` always resolved. */
const verdict = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  event: 'verdict',
  node: 'rules-block',
  status: 'verified',
  attempts: 1,
  provider: 'claude',
  ...extra,
});

describe('journal envelope — the runner attributes', () => {
  test('`plotplot.runner` is the resolved `provider`, verbatim', () => {
    // Free-form in the schema: whatever CLI name the plan named is the fact,
    // unmapped and unnormalised — a table of known names would drop the rest.
    for (const provider of ['claude', 'codex', 'gemini', 'opencode', 'My-Runner_2']) {
      const line = envelope(verdict({ provider }), CLOCK);
      expect(line['plotplot.runner']).toBe(provider);
    }
  });

  test('`gen_ai.request.model` is the pinned model, verbatim', () => {
    for (const model of ['claude-opus-5', 'gpt-5-codex', 'zai/glm-4.6']) {
      const line = envelope(verdict({ model }), CLOCK);
      expect(line['gen_ai.request.model']).toBe(model);
    }
  });

  test('no model in the plan means the key is absent, never null', () => {
    const line = envelope(verdict(), CLOCK);
    expect(Object.keys(line)).not.toContain('gen_ai.request.model');
    // "Never told us" is an absent key in the profile; a null would claim the
    // question was asked and answered with nothing.
    expect(JSON.stringify(line)).not.toContain('gen_ai.request.model');
  });

  test('no pleach line ever carries `gen_ai.provider.name`', () => {
    for (const name of Object.keys(KINDS)) {
      const line = envelope(
        { event: name, node: 'rules-block', gate: 'smoke', provider: 'claude', model: 'opus' },
        CLOCK,
      );
      expect(Object.keys(line)).not.toContain('gen_ai.provider.name');
    }
  });

  test('a line the loop appends without a runner gains neither key', () => {
    // Today only `verdict` carries `provider`; every other event is silent
    // about who ran, and silence is an absent key, not a null one.
    for (const name of Object.keys(KINDS).filter((n) => n !== 'verdict')) {
      const keys = Object.keys(envelope({ event: name, node: 'rules-block' }, CLOCK));
      expect(keys).not.toContain('plotplot.runner');
      expect(keys).not.toContain('gen_ai.request.model');
    }
  });

  test('the event keeps its own `provider` and `model` fields unchanged', () => {
    const event = verdict({ model: 'claude-opus-5' });
    const line = envelope(event, CLOCK);
    expect(line.provider).toBe('claude');
    expect(line.model).toBe('claude-opus-5');
    // The attributes are a mirror, not a move: the input keeps both fields.
    expect(event.provider).toBe('claude');
    expect(event.model).toBe('claude-opus-5');
  });
});
