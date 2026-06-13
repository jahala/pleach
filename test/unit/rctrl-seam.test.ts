/**
 * Unit tests for src/seams/rctrl.ts — spawn argv construction.
 *
 * Subject: createRctrlSeam.spawnWorker builds the rctrl `spawn` argv. The ExecFn
 * here is a real, observable recorder (not a mock) — it captures every argv and
 * returns a well-formed spawn response. Per ENGINEERING.md, an in-memory seam
 * dependency is allowed when the subject is the argv-construction logic itself.
 *
 * Focus: per-provider passthrough of --allowed-tools and --permission-mode.
 *   - --allowed-tools is claude-only (rctrl rejects it elsewhere).
 *   - --permission-mode rides claude (any mode) AND codex ('bypassPermissions' →
 *     codex's --dangerously-bypass-approvals-and-sandbox). Without it an
 *     unattended codex auditor blocks on codex's command-approval prompt.
 *   - gemini gets neither (rctrl rejects both → would fail the spawn).
 */
import { describe, expect, test } from 'bun:test';
import type { ExecFn } from '../../src/loop/deps.ts';
import { createRctrlSeam } from '../../src/seams/rctrl.ts';

// A real ExecFn that records every argv and returns a spawn-shaped success.
// rctrl spawn's stdout must contain the --name value (the seam verifies it).
function makeRecordingExec(): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFn = async (argv) => {
    const a = [...argv];
    calls.push(a);
    const nameIdx = a.indexOf('--name');
    const name = nameIdx >= 0 ? (a[nameIdx + 1] ?? '') : '';
    return { exitCode: 0, output: `spawned: ${name}\n` };
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

describe('createRctrlSeam.spawnWorker — permissionMode / allowedTools passthrough', () => {
  test('codex worker rides --permission-mode bypassPermissions (the unattended bypass)', async () => {
    const { exec, calls } = makeRecordingExec();
    const seam = createRctrlSeam(exec, { bin: 'rctrl', permissionMode: 'bypassPermissions' });
    await seam.spawnWorker({ provider: 'codex', cwd: '/tmp' });
    expect(flagValue(spawnArgv(calls), '--permission-mode')).toBe('bypassPermissions');
  });

  test('codex worker does NOT ride --allowed-tools (claude-only; rctrl rejects it)', async () => {
    const { exec, calls } = makeRecordingExec();
    const seam = createRctrlSeam(exec, {
      bin: 'rctrl',
      allowedTools: 'Read,Bash',
      permissionMode: 'bypassPermissions',
    });
    await seam.spawnWorker({ provider: 'codex', cwd: '/tmp' });
    expect(spawnArgv(calls)).not.toContain('--allowed-tools');
  });

  test('claude worker rides both --allowed-tools and --permission-mode', async () => {
    const { exec, calls } = makeRecordingExec();
    const seam = createRctrlSeam(exec, {
      bin: 'rctrl',
      allowedTools: 'Read,Bash',
      permissionMode: 'bypassPermissions',
    });
    await seam.spawnWorker({ provider: 'claude', cwd: '/tmp' });
    const argv = spawnArgv(calls);
    expect(flagValue(argv, '--allowed-tools')).toBe('Read,Bash');
    expect(flagValue(argv, '--permission-mode')).toBe('bypassPermissions');
  });

  test('gemini worker rides neither (rctrl rejects both → spawn would fail)', async () => {
    const { exec, calls } = makeRecordingExec();
    const seam = createRctrlSeam(exec, {
      bin: 'rctrl',
      allowedTools: 'Read,Bash',
      permissionMode: 'bypassPermissions',
    });
    await seam.spawnWorker({ provider: 'gemini', cwd: '/tmp' });
    const argv = spawnArgv(calls);
    expect(argv).not.toContain('--permission-mode');
    expect(argv).not.toContain('--allowed-tools');
  });
});
