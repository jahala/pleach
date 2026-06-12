import { describe, expect, test } from 'bun:test';
import { PlanInvalidError } from '../../src/core/errors.ts';
import type { AuditResult } from '../../src/core/plan.ts';
import { runNode } from '../../src/loop/run-node.ts';
import { makeHarness, makeNode, type SpawnCtx, stop, type WaitScript } from './harness.ts';

// spec: §6 + ledger — the per-node ladder. In-memory seams (deterministic
// worker, in-memory git); the subject is run-node's control flow.

const DEF = 60_000;

function auditBlock(verdicts: { check: string; verdict: 'pass' | 'partial' | 'fail' }[]): string {
  const body: AuditResult = { verdicts: verdicts.map((v) => ({ ...v, reasons: [] })), drift: [] };
  return `prose\n\`\`\`tend-audit-result\n${JSON.stringify(body)}\n\`\`\`\nmore prose`;
}

describe('runNode — ladder ordering (§6 runNode sequence)', () => {
  test('setup → work → markers → stage → smoke → audit, in order; smoke before audit', async () => {
    const h = makeHarness({
      execScript: () => ({ output: 'ok', exitCode: 0 }),
      changedByNode: { n: ['a.ts'] },
    });
    const node = makeNode({
      id: 'n',
      work: { prompt: 'do' },
      setup: 'install deps',
      accept: {
        smoke: 'run smoke',
        audit: { command: 'tend audit n', provider: 'codex' },
      },
    });
    const r = await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    expect(r.verdict.status).toBe('done');

    const k = h.log.kinds();
    const idx = (s: string) => k.indexOf(s);
    // isolate first
    expect(idx('isolate')).toBeLessThan(idx('spawn:build'));
    // setup exec runs after isolate, before the build send
    const setupExec = h.log.events.find((e) => e.kind === 'exec' && e.detail === 'install deps');
    expect(setupExec).toBeDefined();
    expect((setupExec as { at: number }).at).toBeGreaterThan(h.log.first('isolate'));
    expect((setupExec as { at: number }).at).toBeLessThan(h.log.first('send'));
    // marker scan → stage → smoke → audit-spawn ordering
    expect(h.log.first('scanMarkers')).toBeLessThan(h.log.first('stage'));
    const smokeExec = h.log.events.find((e) => e.kind === 'exec' && e.detail === 'run smoke');
    expect((smokeExec as { at: number }).at).toBeGreaterThan(h.log.first('stage'));
    expect((smokeExec as { at: number }).at).toBeLessThan(h.log.first('spawn:audit'));
  });

  test('smoke failure prevents the audit worker from spawning', async () => {
    const h = makeHarness({
      execScript: (argv) =>
        argv.join(' ') === 'run smoke'
          ? { output: 'smoke boom', exitCode: 1 }
          : { output: '', exitCode: 0 },
    });
    const node = makeNode({
      id: 'n',
      accept: { smoke: 'run smoke', audit: { command: 'audit n', provider: 'codex' } },
      policy: { maxAttempts: 1, onDead: 'fail', reauditWhen: ['compacted'] },
    });
    const r = await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    expect(r.verdict.status).toBe('failed');
    expect(h.log.count('spawn:audit')).toBe(0);
  });
});

describe('runNode — provider diversity (ledger M1)', () => {
  test('resolved build provider === audit provider → PlanInvalidError before spawn', async () => {
    const h = makeHarness();
    const node = makeNode({
      id: 'n',
      worker: { provider: 'codex' },
      accept: { audit: { command: 'audit n', provider: 'codex' } },
    });
    let err: unknown;
    try {
      await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PlanInvalidError);
    expect(h.log.count('spawn:build')).toBe(0);
  });

  test('omitted build provider defaults to claude — audit codex is fine', async () => {
    const h = makeHarness({ auditEgress: () => auditBlock([{ check: 'c', verdict: 'pass' }]) });
    const node = makeNode({
      id: 'n',
      accept: { audit: { command: 'audit n', provider: 'codex' } },
    });
    const r = await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    expect(r.verdict.status).toBe('done');
  });
});

describe('runNode — worker always killed (finally)', () => {
  test('build worker is killed after its wait resolves', async () => {
    const h = makeHarness();
    const node = makeNode({ id: 'n' });
    await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    expect(h.log.count('kill', 'n')).toBeGreaterThanOrEqual(1);
  });
});

describe('runNode — non-stop reasons', () => {
  test('input → status blocked, blockedReason carries the message, no retry', async () => {
    const script: WaitScript = (ctx) =>
      ctx.role === 'build' ? stop({ reason: 'input', message: 'allow Bash?' }) : stop();
    const h = makeHarness({ waitScript: script });
    const node = makeNode({
      id: 'n',
      policy: { maxAttempts: 3, onDead: 'resume', reauditWhen: ['compacted'] },
    });
    const r = await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    expect(r.verdict.status).toBe('blocked');
    expect(r.verdict.evidence.blockedReason).toBe('allow Bash?');
    expect(h.log.count('spawn:build', 'n')).toBe(1); // no retry
    expect(h.log.count('kill', 'n')).toBe(1);
  });

  test('dead with onDead resume → dispose + re-isolate + fresh attempt', async () => {
    let buildSpawns = 0;
    const script: WaitScript = (ctx) => {
      if (ctx.role !== 'build') return stop();
      buildSpawns += 1;
      return buildSpawns === 1 ? stop({ reason: 'dead' }) : stop();
    };
    const h = makeHarness({ waitScript: script });
    const node = makeNode({
      id: 'n',
      policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
    });
    const r = await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    expect(r.verdict.status).toBe('done');
    expect(h.log.count('isolate', 'n')).toBe(2); // re-isolated
    expect(h.log.count('dispose', 'n')).toBe(1); // first iso disposed before re-isolate
    // dispose happened before second isolate
    expect(h.log.first('dispose', 'n')).toBeLessThan(h.log.last('isolate', 'n'));
  });

  test('dead with onDead fail → status dead, no re-isolate', async () => {
    const script: WaitScript = (ctx) => (ctx.role === 'build' ? stop({ reason: 'dead' }) : stop());
    const h = makeHarness({ waitScript: script });
    const node = makeNode({
      id: 'n',
      policy: { maxAttempts: 2, onDead: 'fail', reauditWhen: ['compacted'] },
    });
    const r = await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    expect(r.verdict.status).toBe('dead');
    expect(h.log.count('isolate', 'n')).toBe(1);
  });
});

describe('runNode — gates', () => {
  test('marker gate hit → retryable; clean on retry → done', async () => {
    let isoCount = 0;
    const h = makeHarness({
      // first isolate leaves markers; second is clean
      markersByNode: { n: ['conflicted.ts'] },
    });
    // override scanMarkers via markers map keyed by cwd; the first cwd has the
    // marker, the second (retry, reused tree per spec) — we simulate clearing by
    // having the worker "resolve" it: emulate by clearing markers on 2nd build.
    const node = makeNode({
      id: 'n',
      policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
    });
    // Patch: clear markers after first attempt's scan. We do this by wrapping.
    const realScan = h.deps.isolate.scanMarkers;
    h.deps.isolate.scanMarkers = async (cwd: string) => {
      isoCount += 1;
      if (isoCount === 1) return realScan(cwd);
      return [];
    };
    const r = await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    expect(r.verdict.status).toBe('done');
    expect(h.log.count('spawn:build', 'n')).toBe(2);
  });

  test('smoke fail exhausts attempts → status failed with gate evidence', async () => {
    const h = makeHarness({
      execScript: (argv) =>
        argv.join(' ') === 'smoke' ? { output: 'broke', exitCode: 2 } : { output: '', exitCode: 0 },
    });
    const node = makeNode({
      id: 'n',
      accept: { smoke: 'smoke' },
      policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
    });
    const r = await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    expect(r.verdict.status).toBe('failed');
    expect(r.verdict.evidence.gate).toEqual({ ran: 'smoke', exitCode: 2 });
    expect(r.verdict.attempts).toBe(2);
  });

  test('setup failure → status failed, gate.ran is the setup command, consumes attempts', async () => {
    const h = makeHarness({
      execScript: (argv) =>
        argv.join(' ') === 'bad setup'
          ? { output: 'no net', exitCode: 1 }
          : { output: '', exitCode: 0 },
    });
    const node = makeNode({
      id: 'n',
      setup: 'bad setup',
      policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
    });
    const r = await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    expect(r.verdict.status).toBe('failed');
    expect(r.verdict.evidence.gate).toEqual({ ran: 'bad setup', exitCode: 1 });
    // setup-fail is retryable → SAME tree reused (setup idempotent by contract)
    expect(h.log.count('isolate', 'n')).toBe(1);
    expect(h.log.count('exec', undefined)).toBe(2); // setup re-execed each attempt
  });
});

describe('runNode — audit', () => {
  test('audit-fail verdict → retryable; build re-prompted with reasons; pass on retry → done', async () => {
    let buildSpawns = 0;
    const script: WaitScript = (ctx: SpawnCtx) => {
      if (ctx.role === 'build') {
        buildSpawns += 1;
        return stop();
      }
      // auditor: first audit fails, second passes
      return ctx.spawnIndex === 0
        ? stop({ finalMessage: auditBlock([{ check: 'c', verdict: 'fail' }]) })
        : stop({ finalMessage: auditBlock([{ check: 'c', verdict: 'pass' }]) });
    };
    const h = makeHarness({ waitScript: script });
    const node = makeNode({
      id: 'n',
      accept: { audit: { command: 'audit n', provider: 'codex' } },
      policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
    });
    const r = await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    expect(r.verdict.status).toBe('done');
    expect(buildSpawns).toBe(2); // fresh build worker on audit-fail retry
  });

  test('audit egress garbage → re-run ONLY the auditor (reaudit budget 2); good egress closes', async () => {
    let buildSpawns = 0;
    let auditSpawns = 0;
    const script: WaitScript = (ctx: SpawnCtx) => {
      if (ctx.role === 'build') {
        buildSpawns += 1;
        return stop();
      }
      auditSpawns += 1;
      return auditSpawns === 1
        ? stop({ finalMessage: 'no fenced block here — garbage' })
        : stop({ finalMessage: auditBlock([{ check: 'c', verdict: 'pass' }]) });
    };
    const h = makeHarness({ waitScript: script });
    const node = makeNode({
      id: 'n',
      accept: { audit: { command: 'audit n', provider: 'codex' } },
      policy: { maxAttempts: 1, onDead: 'fail', reauditWhen: ['compacted'] },
    });
    const r = await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    expect(r.verdict.status).toBe('done');
    expect(buildSpawns).toBe(1); // builder spawned ONCE (C4 — only auditor reruns)
    expect(auditSpawns).toBe(2);
  });

  test('audit egress garbage exhausts reaudit budget → status failed, gate.ran = audit command', async () => {
    const script: WaitScript = (ctx) =>
      ctx.role === 'build' ? stop() : stop({ finalMessage: 'always garbage' });
    const h = makeHarness({ waitScript: script });
    const node = makeNode({
      id: 'n',
      accept: { audit: { command: 'audit n', provider: 'codex' } },
      policy: { maxAttempts: 1, onDead: 'fail', reauditWhen: ['compacted'] },
    });
    const r = await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    expect(r.verdict.status).toBe('failed');
    expect(r.verdict.evidence.gate?.ran).toContain('audit n');
    expect(r.verdict.evidence.gate?.ran).toContain('unparseable');
  });

  test('auditor dies (non-stop reason) → node fails distinctly, gate names the auditor reason', async () => {
    // A dead/blocked/timed-out auditor returns no verdict — it must NOT be fed
    // to the JSON parser as if it were bad egress. The gate records the reason.
    const script: WaitScript = (ctx) =>
      ctx.role === 'build'
        ? stop()
        : { reason: 'dead', finalMessage: '', filesTouched: [], telemetry: {} };
    const h = makeHarness({ waitScript: script });
    const node = makeNode({
      id: 'n',
      accept: { audit: { command: 'audit n', provider: 'codex' } },
      policy: { maxAttempts: 1, onDead: 'fail', reauditWhen: ['compacted'] },
    });
    const r = await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    expect(r.verdict.status).toBe('failed');
    expect(r.verdict.evidence.gate?.ran).toContain('auditor dead');
  });
});

describe('runNode — retry carries evidence (ledger A3)', () => {
  test('smoke retry re-prompt contains the smoke output tail', async () => {
    const h = makeHarness({
      execScript: (argv) =>
        argv.join(' ') === 'smoke'
          ? { output: 'SMOKE-OUTPUT-XYZ', exitCode: 1 }
          : { output: '', exitCode: 0 },
    });
    const node = makeNode({
      id: 'n',
      work: { prompt: 'base prompt' },
      accept: { smoke: 'smoke' },
      policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
    });
    await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    const sends = h.log.of('send').filter((e) => e.node === 'n');
    const retrySend = sends[sends.length - 1];
    expect(retrySend?.detail).toContain('SMOKE-OUTPUT-XYZ');
  });

  test('marker retry re-prompt names the conflict files', async () => {
    let scans = 0;
    const h = makeHarness({ markersByNode: { n: ['lib/x.ts', 'lib/y.ts'] } });
    const realScan = h.deps.isolate.scanMarkers;
    h.deps.isolate.scanMarkers = async (cwd: string) => {
      scans += 1;
      return scans === 1 ? realScan(cwd) : [];
    };
    const node = makeNode({
      id: 'n',
      work: { prompt: 'base' },
      policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
    });
    await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    const sends = h.log.of('send').filter((e) => e.node === 'n');
    const retrySend = sends[sends.length - 1];
    expect(retrySend?.detail).toContain('lib/x.ts');
    expect(retrySend?.detail).toContain('lib/y.ts');
  });

  test('audit-fail retry re-prompt contains the failing check reasons', async () => {
    let buildSpawns = 0;
    const failingAudit = `\`\`\`tend-audit-result\n${JSON.stringify({
      verdicts: [{ check: 'login-works', verdict: 'fail', reasons: ['no session cookie set'] }],
      drift: [],
    })}\n\`\`\``;
    const script: WaitScript = (ctx) => {
      if (ctx.role === 'build') {
        buildSpawns += 1;
        return stop();
      }
      return ctx.spawnIndex === 0
        ? stop({ finalMessage: failingAudit })
        : stop({ finalMessage: auditBlock([{ check: 'login-works', verdict: 'pass' }]) });
    };
    const h = makeHarness({ waitScript: script });
    const node = makeNode({
      id: 'n',
      work: { prompt: 'base' },
      accept: { audit: { command: 'audit n', provider: 'codex' } },
      policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
    });
    await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    const sends = h.log.of('send').filter((e) => e.node === 'n' && e.detail?.startsWith('build:'));
    const retrySend = sends[sends.length - 1];
    expect(retrySend?.detail).toContain('no session cookie set');
    expect(buildSpawns).toBe(2);
  });

  test('first prompt includes conflict files when isolate reports them', async () => {
    const h = makeHarness({ conflicts: { n: ['merge/a.ts'] } });
    const node = makeNode({ id: 'n', work: { prompt: 'base' } });
    await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    const firstSend = h.log.of('send').find((e) => e.node === 'n');
    expect(firstSend?.detail).toContain('merge/a.ts');
  });
});

describe('runNode — happy verdict shape', () => {
  test('done verdict carries filesTouched, telemetry, attempts; returns iso + stagedFiles', async () => {
    const h = makeHarness({ changedByNode: { n: ['b.ts'] } });
    const node = makeNode({ id: 'n', work: { prompt: 'p' } });
    const r = await runNode(node, ['base'], h.deps, { defaultTimeoutMs: DEF });
    expect(r.verdict.status).toBe('done');
    expect(r.verdict.evidence.filesTouched).toContain('b.ts');
    expect(r.verdict.attempts).toBe(1);
    expect(r.iso).toBeDefined();
    expect(r.stagedFiles).toContain('b.ts');
    // run-node does NOT commit — that's run-plan's job (commit-before-emit)
    expect(h.log.count('commitBranch')).toBe(0);
  });
});

describe('runNode — timeout default threading', () => {
  test('node without policy.timeoutMs uses opts.defaultTimeoutMs for wait + exec', async () => {
    const seen: (number | undefined)[] = [];
    const h = makeHarness();
    const realExec = h.deps.exec;
    h.deps.exec = async (argv, o) => {
      seen.push(o.timeoutMs);
      return realExec(argv, o);
    };
    const node = makeNode({ id: 'n', setup: 'setup cmd', accept: { smoke: 'smoke cmd' } });
    await runNode(node, ['base'], h.deps, { defaultTimeoutMs: 777 });
    // every exec saw the default timeout
    expect(seen.every((t) => t === 777)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });
});
