// The ordinary-check defect (issue #149), at the ladder: a node whose
// accept.audit.command is `pleach audit-wrap -- <check>` closes — the block
// audit-wrap renders is exactly what the audit ladder's egress parser reads.
// In-memory seams; the block is produced by the same pure render the CLI uses.
import { describe, expect, test } from 'bun:test';
import { renderAuditResultBlock } from '../../src/core/audit-egress.ts';
import { runNode } from '../../src/loop/run-node.ts';
import { makeHarness, makeNode } from './harness.ts';

describe('audit-wrap — an ordinary check passes the egress (issue #149)', () => {
  test('a node whose audit.command is `pleach audit-wrap -- <check>` closes verified', async () => {
    const block = renderAuditResultBlock('app-check', 0, 'ok\n');
    const h = makeHarness({ auditEgress: () => block });
    const node = makeNode({
      id: 'app',
      accept: { audit: { command: 'pleach audit-wrap -- bash -lc "echo ok"', provider: 'codex' } },
    });

    const r = await runNode(node, ['base'], h.deps, { defaultTimeoutMs: 1000 });

    expect(r.verdict.status).toBe('done');
    expect(r.verdict.output).toMatchObject({
      verdicts: [{ check: 'app-check', verdict: 'pass' }],
    });
  });
});
