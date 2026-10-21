/**
 * Unit tests for src/seams/umbel.ts — spawn argv construction.
 *
 * Subject: createUmbelSeam.spawnWorker builds the umbel `spawn` argv. The ExecFn
 * here is a real, observable recorder (not a mock) — it captures every argv and
 * returns a well-formed spawn response. Per ENGINEERING.md, an in-memory seam
 * dependency is allowed when the subject is the argv-construction logic itself.
 *
 * Focus: per-provider passthrough of --allowed-tools and --permission-mode.
 *   - --allowed-tools is claude-only (umbel rejects it elsewhere).
 *   - --permission-mode rides claude (any mode) AND codex ('bypassPermissions' →
 *     codex's --dangerously-bypass-approvals-and-sandbox). Without it an
 *     unattended codex auditor blocks on codex's command-approval prompt.
 *   - gemini gets neither (umbel rejects both → would fail the spawn).
 */
import { describe, expect, test } from 'bun:test';
import { createUmbelSeam } from '../../src/adapters/umbel.ts';
import type { ExecFn } from '../../src/loop/deps.ts';

// A real ExecFn that records every argv and returns a spawn-shaped success.
// umbel spawn's stdout must contain the --name value (the seam verifies it).
function makeRecordingExec(): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFn = async (argv) => {
    const a = [...argv];
    calls.push(a);
    const nameIdx = a.indexOf('--name');
    const name = nameIdx >= 0 ? (a[nameIdx + 1] ?? '') : '';
    const output = `spawned: ${name}\n`;
    return { exitCode: 0, output, stdout: output };
  };
  return { exec, calls };
}

function spawnArgv(calls: string[][]): string[] {
  const argv = calls.find((a) => a.includes('spawn'));
  if (argv === undefined) throw new Error('no spawn invocation recorded');
  return argv;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

describe('createUmbelSeam.spawnWorker — permissionMode / allowedTools passthrough', () => {
  test('codex worker rides --permission-mode bypassPermissions (the unattended bypass)', async () => {
    const { exec, calls } = makeRecordingExec();
    const seam = createUmbelSeam(exec, { bin: 'umbel', permissionMode: 'bypassPermissions' });
    await seam.spawnWorker({ provider: 'codex', cwd: '/tmp' });
    expect(flagValue(spawnArgv(calls), '--permission-mode')).toBe('bypassPermissions');
  });

  test('codex worker does NOT ride --allowed-tools (claude-only; umbel rejects it)', async () => {
    const { exec, calls } = makeRecordingExec();
    const seam = createUmbelSeam(exec, {
      bin: 'umbel',
      allowedTools: 'Read,Bash',
      permissionMode: 'bypassPermissions',
    });
    await seam.spawnWorker({ provider: 'codex', cwd: '/tmp' });
    expect(spawnArgv(calls)).not.toContain('--allowed-tools');
  });

  test('claude worker rides both --allowed-tools and --permission-mode', async () => {
    const { exec, calls } = makeRecordingExec();
    const seam = createUmbelSeam(exec, {
      bin: 'umbel',
      allowedTools: 'Read,Bash',
      permissionMode: 'bypassPermissions',
    });
    await seam.spawnWorker({ provider: 'claude', cwd: '/tmp' });
    const argv = spawnArgv(calls);
    expect(flagValue(argv, '--allowed-tools')).toBe('Read,Bash');
    expect(flagValue(argv, '--permission-mode')).toBe('bypassPermissions');
  });

  test('gemini worker rides neither (umbel rejects both → spawn would fail)', async () => {
    const { exec, calls } = makeRecordingExec();
    const seam = createUmbelSeam(exec, {
      bin: 'umbel',
      allowedTools: 'Read,Bash',
      permissionMode: 'bypassPermissions',
    });
    await seam.spawnWorker({ provider: 'gemini', cwd: '/tmp' });
    const argv = spawnArgv(calls);
    expect(argv).not.toContain('--permission-mode');
    expect(argv).not.toContain('--allowed-tools');
  });
});

// ── the spawn-void (decker finding, 2026-08-20) ──────────────────────────────
// umbel spawn can exit 0 and echo the name while no tmux session materializes
// (e.g. launched under nohup with no tmux server bootable). Untreated, that
// surfaces hours later as a misleading wait-timeout with zero worker output.
// The seam must probe session existence right after spawn and fail FAST.
describe('createUmbelSeam.spawnWorker — post-spawn existence probe', () => {
  test('spawn that reports success but leaves no session fails fast as a spawn failure', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (argv) => {
      const a = [...argv];
      calls.push(a);
      if (a.includes('spawn')) {
        const name = a[a.indexOf('--name') + 1] ?? '';
        const output = `spawned: ${name}\n`;
        return { exitCode: 0, output, stdout: output };
      }
      // the status probe: session never materialized
      const output = 'umbel: Session not found\n';
      return { exitCode: 1, output, stdout: output };
    };
    const seam = createUmbelSeam(exec, { bin: 'umbel' });

    expect(seam.spawnWorker({ cwd: '/tmp' })).rejects.toThrow(
      /spawn reported success but session .* does not exist.*tmux/,
    );
  });

  test('the probe rides every spawn: umbel status <name> follows umbel spawn', async () => {
    const { exec, calls } = makeRecordingExec();
    const seam = createUmbelSeam(exec, { bin: 'umbel' });
    const worker = await seam.spawnWorker({ cwd: '/tmp' });

    const spawnIdx = calls.findIndex((a) => a.includes('spawn'));
    const statusIdx = calls.findIndex((a) => a[1] === 'status');
    expect(statusIdx).toBeGreaterThan(spawnIdx);
    expect(calls[statusIdx]?.[2]).toBe(worker.__name);
  });
});

// ── unattended by default (owner ruling, decker run 4) ──────────────────────
// A fleet worker must never be interactively prompted — the needs-a-human lane
// is for refusals and human checks, not consent clicks. umbel#57 maps
// --unattended to per-provider no-prompt flags and fails fast at spawn for a
// provider that cannot comply; pleach's posture: every spawn is unattended,
// an EXPLICIT permissionMode still rides (umbel gives it precedence).
describe('createUmbelSeam.spawnWorker — unattended posture', () => {
  test('every spawn rides --unattended, whatever the provider', async () => {
    for (const provider of [undefined, 'claude', 'codex', 'gemini', 'opencode']) {
      const { exec, calls } = makeRecordingExec();
      const seam = createUmbelSeam(exec, { bin: 'umbel' });
      await seam.spawnWorker({ ...(provider ? { provider } : {}), cwd: '/tmp' });
      expect(spawnArgv(calls)).toContain('--unattended');
    }
  });

  test('an explicit permissionMode still rides for claude/codex — umbel gives it precedence', async () => {
    const { exec, calls } = makeRecordingExec();
    const seam = createUmbelSeam(exec, { bin: 'umbel', permissionMode: 'acceptEdits' });
    await seam.spawnWorker({ provider: 'claude', cwd: '/tmp' });
    const argv = spawnArgv(calls);
    expect(argv).toContain('--unattended');
    expect(flagValue(argv, '--permission-mode')).toBe('acceptEdits');
  });

  test('gemini keeps permission-mode suppressed (umbel rejects it) but is unattended', async () => {
    const { exec, calls } = makeRecordingExec();
    const seam = createUmbelSeam(exec, { bin: 'umbel', permissionMode: 'bypassPermissions' });
    await seam.spawnWorker({ provider: 'gemini', cwd: '/tmp' });
    const argv = spawnArgv(calls);
    expect(argv).toContain('--unattended');
    expect(argv).not.toContain('--permission-mode');
  });
});

// ── the idle timeout (ledger D16) ────────────────────────────────────────────
// A wedged worker must end at an idle timeout the conductor chooses, not at the
// attempt clock. `Worker.wait`'s idleMs is that choice; the adapter's whole job
// is to hand it to umbel as `--idle-timeout <n>ms`. No idleMs, no flag — the
// adapter invents no default, because the policy is the conductor's.
describe('createUmbelSeam.wait — --idle-timeout passthrough', () => {
  // A real ExecFn that records every argv and answers each verb in its own
  // shape: spawn echoes the name, status succeeds, send hands back a
  // sinceMtime, wait reports a finished turn.
  function makeVerbExec(): { exec: ExecFn; calls: string[][] } {
    const calls: string[][] = [];
    const exec: ExecFn = async (argv) => {
      const a = [...argv];
      calls.push(a);
      const ok = (output: string) => ({ exitCode: 0, output, stdout: output });
      if (a.includes('spawn')) return ok(`spawned: ${a[a.indexOf('--name') + 1] ?? ''}\n`);
      if (a[1] === 'send') return ok('{"sinceMtime":17}\n');
      if (a[1] === 'wait') return ok('{"reason":"idle"}\n');
      return ok('');
    };
    return { exec, calls };
  }

  function waitArgv(calls: string[][]): string[] {
    const argv = calls.find((a) => a[1] === 'wait');
    if (argv === undefined) throw new Error('no wait invocation recorded');
    return argv;
  }

  test('idleMs rides as --idle-timeout in milliseconds', async () => {
    const { exec, calls } = makeVerbExec();
    const seam = createUmbelSeam(exec, { bin: 'umbel' });
    const worker = await seam.spawnWorker({ cwd: '/tmp' });
    await worker.send('do the thing');
    await worker.wait({ timeoutMs: 60_000, idleMs: 600_000 });
    expect(flagValue(waitArgv(calls), '--idle-timeout')).toBe('600000ms');
  });

  test('no idleMs, no --idle-timeout — the adapter invents no default', async () => {
    const { exec, calls } = makeVerbExec();
    const seam = createUmbelSeam(exec, { bin: 'umbel' });
    const worker = await seam.spawnWorker({ cwd: '/tmp' });
    await worker.send('do the thing');
    await worker.wait({ timeoutMs: 60_000 });
    expect(waitArgv(calls)).not.toContain('--idle-timeout');
  });
});

// ── env passes by name only (issue #126, #146) ──────────────────────────────
// A worker env var's value must never appear on the umbel command line, where
// `ps` shows it. The adapter passes `--env KEY` (the bare name umbel already
// supports) and puts the value in the spawn process's own env. Seam-level
// workerEnv and a cast's spec.env ride the same path.
describe('createUmbelSeam.spawnWorker — env passes by name only', () => {
  interface RecordedCall {
    argv: string[];
    env?: Record<string, string>;
  }

  function makeEnvRecordingExec(): { exec: ExecFn; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const exec: ExecFn = async (argv, opts) => {
      const a = [...argv];
      calls.push({ argv: a, env: opts.env });
      const nameIdx = a.indexOf('--name');
      const name = nameIdx >= 0 ? (a[nameIdx + 1] ?? '') : '';
      const output = `spawned: ${name}\n`;
      return { exitCode: 0, output, stdout: output };
    };
    return { exec, calls };
  }

  function spawnCall(calls: RecordedCall[]): RecordedCall {
    const call = calls.find((c) => c.argv.includes('spawn'));
    if (call === undefined) throw new Error('no spawn invocation recorded');
    return call;
  }

  test('a cast env value rides --env KEY (bare name), the value in the spawn env only', async () => {
    const { exec, calls } = makeEnvRecordingExec();
    const seam = createUmbelSeam(exec, { bin: 'umbel' });
    await seam.spawnWorker({
      provider: 'claude',
      cwd: '/tmp',
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-secret-123' },
    });

    const argv = spawnCall(calls).argv;
    expect(argv).toContain('--env');
    expect(argv).toContain('ANTHROPIC_AUTH_TOKEN');
    // The value must never ride the command line.
    expect(argv).not.toContain('sk-secret-123');
    expect(argv.join(' ')).not.toContain('sk-secret-123');
    // It is in the spawn process env instead.
    expect(spawnCall(calls).env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-secret-123');
  });

  test('seam-level workerEnv rides --env KEY too, never KEY=VALUE (issue #126)', async () => {
    const { exec, calls } = makeEnvRecordingExec();
    const seam = createUmbelSeam(exec, {
      bin: 'umbel',
      workerEnv: { FAKE_CLAUDE_JSONL_DIR: '/tmp/secret-dir-456' },
    });
    await seam.spawnWorker({ cwd: '/tmp' });

    const argv = spawnCall(calls).argv;
    expect(argv).toContain('--env');
    expect(argv).toContain('FAKE_CLAUDE_JSONL_DIR');
    expect(argv).not.toContain('/tmp/secret-dir-456');
    expect(argv.join(' ')).not.toContain('/tmp/secret-dir-456');
    expect(spawnCall(calls).env?.FAKE_CLAUDE_JSONL_DIR).toBe('/tmp/secret-dir-456');
  });

  test('a cast env key overrides the same seam workerEnv key in the spawn env', async () => {
    const { exec, calls } = makeEnvRecordingExec();
    const seam = createUmbelSeam(exec, {
      bin: 'umbel',
      workerEnv: { ANTHROPIC_AUTH_TOKEN: 'seam-value' },
    });
    await seam.spawnWorker({
      provider: 'claude',
      cwd: '/tmp',
      env: { ANTHROPIC_AUTH_TOKEN: 'cast-value' },
    });

    const call = spawnCall(calls);
    expect(call.argv.filter((a) => a === 'ANTHROPIC_AUTH_TOKEN')).toHaveLength(1);
    expect(call.env?.ANTHROPIC_AUTH_TOKEN).toBe('cast-value');
  });
});
