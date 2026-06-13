import { describe, expect, test } from 'bun:test';
import { buildAuditPrompt, extractAuditJson } from '../../src/core/audit-egress.ts';
import { AuditParseError } from '../../src/core/errors.ts';

// ledger: C4 — untruncated audit egress; the LAST fenced tend-audit-result block
// is the authoritative one; unparseable / missing → AuditParseError(raw).

const FENCE = 'tend-audit-result';

function block(json: string): string {
  return [`\`\`\`${FENCE}`, json, '```'].join('\n');
}

describe('extractAuditJson — happy path', () => {
  test('parses a single fenced tend-audit-result block', () => {
    const json = '{"verdicts":[{"check":"c1","verdict":"pass"}]}';
    const msg = `Here is my audit.\n\n${block(json)}\n\nThanks.`;
    expect(extractAuditJson(msg)).toEqual({
      verdicts: [{ check: 'c1', verdict: 'pass' }],
    });
  });

  test('parses a block with no surrounding prose', () => {
    const json = '{"verdicts":[]}';
    expect(extractAuditJson(block(json))).toEqual({ verdicts: [] });
  });
});

describe('extractAuditJson — multiple blocks: last wins', () => {
  test('returns the JSON of the LAST tend-audit-result block', () => {
    const first = block('{"verdicts":[{"check":"old","verdict":"fail"}]}');
    const last = block('{"verdicts":[{"check":"new","verdict":"pass"}]}');
    const msg = `attempt one\n${first}\n\nrevised\n${last}\n`;
    expect(extractAuditJson(msg)).toEqual({
      verdicts: [{ check: 'new', verdict: 'pass' }],
    });
  });
});

describe('extractAuditJson — surrounding prose ignored', () => {
  test('prose containing JSON-like text outside the fence is ignored', () => {
    const msg = [
      'I considered returning {"verdicts": "nope"} but instead:',
      block('{"verdicts":[{"check":"real","verdict":"partial"}]}'),
      'Note: {"trailing":"garbage"} should not be parsed.',
    ].join('\n');
    expect(extractAuditJson(msg)).toEqual({
      verdicts: [{ check: 'real', verdict: 'partial' }],
    });
  });
});

describe('extractAuditJson — failure modes throw AuditParseError', () => {
  test('no tend-audit-result block → throws AuditParseError(raw)', () => {
    const msg = 'I finished the audit but forgot to fence anything.';
    let thrown: unknown;
    try {
      extractAuditJson(msg);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AuditParseError);
    expect((thrown as AuditParseError).raw).toBe(msg);
  });

  test('block present but content is not valid JSON → throws AuditParseError(raw)', () => {
    const msg = block('{verdicts: not json,}');
    let thrown: unknown;
    try {
      extractAuditJson(msg);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AuditParseError);
    expect((thrown as AuditParseError).raw).toBe(msg);
  });

  test('a differently-labeled fence is not a tend-audit-result block', () => {
    const msg = ['```json', '{"verdicts":[]}', '```'].join('\n');
    expect(() => extractAuditJson(msg)).toThrow(AuditParseError);
  });

  test('empty string → throws AuditParseError', () => {
    expect(() => extractAuditJson('')).toThrow(AuditParseError);
  });
});

// The defect the P6 proof named: sending the auditor the BARE command leaves the
// deterministic tend-audit-result block in the tool's stdout while the agent
// replies with a prose summary — extractAuditJson reads the agent's message, so
// it finds no block ("egress unparseable"). buildAuditPrompt forces the block
// into the reply. This module owns both halves of the egress contract.
describe('buildAuditPrompt — elicits a parseable egress', () => {
  test('embeds the exact command to run', () => {
    const cmd = 'bun /missoula/src/bin/tend.ts audit wordcount';
    expect(buildAuditPrompt(cmd)).toContain(cmd);
  });

  test('instructs the auditor to reproduce the tend-audit-result block verbatim', () => {
    const p = buildAuditPrompt('audit-cmd');
    expect(p).toContain(FENCE); // names the exact fence the parser reads
    expect(p).toMatch(/verbatim/i);
    expect(p).toMatch(/do not summarize/i);
  });
});
