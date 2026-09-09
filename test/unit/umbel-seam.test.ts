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
