import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptedAuditResult, scriptedRunner } from '../../src/adapters/scripted.ts';
import { extractAuditJson } from '../../src/core/audit-egress.ts';
import { AuditResultSchema } from '../../src/core/plan.ts';

// Subject: scriptedRunner — a real, deterministic RunnerSeam (no LLM, no keys)
// that applies canned worktree changes and returns canned worker output. It is
// what lets a plan run end-to-end without an external runner binary: builds are
// matched by a prompt substring, the cross-provider auditor by its provider.

describe('scriptedRunner — deterministic, no-LLM RunnerSeam', () => {
  test('a matched build scenario writes its files into cwd and returns its message', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pleach-scripted-'));
    try {
      const runner = scriptedRunner([
        {
          prompt: 'wordcount',
          files: { 'wc.ts': 'export const count = 1;\n' },
          message: 'implemented wordcount',
        },
      ]);
      const worker = await runner.spawnWorker({ provider: 'claude', cwd });
      await worker.send('please implement wordcount');
      const r = await worker.wait({ timeoutMs: 1_000 });
      await worker.kill();

      expect(r.reason).toBe('stop');
      expect(r.finalMessage).toBe('implemented wordcount');
      expect(r.filesTouched).toContain('wc.ts');
      expect(await readFile(join(cwd, 'wc.ts'), 'utf8')).toContain('export const count');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('a provider-matched audit scenario returns a parseable, passing AuditResult fence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pleach-scripted-'));
    try {
      const runner = scriptedRunner([
        {
          provider: 'codex',
          message: scriptedAuditResult([{ check: 'wc-correct', verdict: 'pass' }]),
        },
      ]);
      const worker = await runner.spawnWorker({ provider: 'codex', cwd });
      await worker.send('audit the work');
      const r = await worker.wait({ timeoutMs: 1_000 });
      await worker.kill();

      const parsed = AuditResultSchema.parse(extractAuditJson(r.finalMessage));
      expect(parsed.verdicts[0]?.verdict).toBe('pass');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
