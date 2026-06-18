import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AuditResult } from '../core/plan.ts';
import type { RunnerSeam, Worker, WorkerResult } from '../loop/deps.ts';

// scriptedRunner — a real, deterministic RunnerSeam with no LLM, no keys, no
// network. It drives a plan by applying canned worktree changes and returning
// canned worker output, so a plan can run end-to-end (and be tested in CI) with
// no external runner binary. It is NOT a behaviour-mock: it really writes files
// into the worktree and really returns the WorkerResult the loop gates on — the
// determinism is the point, not the fakery.
//
// A spawned worker selects the FIRST scenario matching both filters: `provider`
// (the spawn's provider — picks the cross-provider auditor) and `prompt` (a
// substring of the text the worker was last sent — picks per-node build output).
// An unset filter matches anything; no match yields an empty stop.

export interface ScriptedScenario {
  /** Matches when the spawn provider equals this (e.g. the cross-provider auditor). */
  provider?: string;
  /** Matches when the text the worker was last sent contains this substring. */
  prompt?: string;
  /** Files written into the worktree on wait(): relative path → contents. */
  files?: Record<string, string>;
  /** The worker's final message (default ''). For an auditor, a fenced result. */
  message?: string;
  /** The worker's stop reason (default 'stop'). */
  reason?: WorkerResult['reason'];
}

// Build the fenced `tend-audit-result` block the audit egress parses, so a
// scripted auditor can return a verdict the loop accepts (mirrors the egress
// contract owned by core/audit-egress.ts).
export function scriptedAuditResult(
  verdicts: { check: string; verdict: 'pass' | 'partial' | 'fail'; reasons?: string[] }[],
): string {
  const body: AuditResult = {
    verdicts: verdicts.map((v) => ({
      check: v.check,
      verdict: v.verdict,
      reasons: v.reasons ?? [],
    })),
    drift: [],
  };
  return `\`\`\`tend-audit-result\n${JSON.stringify(body)}\n\`\`\``;
}

function select(
  scenarios: readonly ScriptedScenario[],
  provider: string | undefined,
  prompt: string,
): ScriptedScenario | undefined {
  return scenarios.find(
    (s) =>
      (s.provider === undefined || s.provider === provider) &&
      (s.prompt === undefined || prompt.includes(s.prompt)),
  );
}

export function scriptedRunner(scenarios: readonly ScriptedScenario[]): RunnerSeam {
  return {
    spawnWorker: async (spec) => {
      let lastPrompt = '';
      const worker: Worker = {
        send: async (text) => {
          lastPrompt = text;
        },
        wait: async () => {
          const scenario = select(scenarios, spec.provider, lastPrompt);
          const files = scenario?.files ?? {};
          for (const [rel, contents] of Object.entries(files)) {
            const abs = join(spec.cwd, rel);
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, contents);
          }
          return {
            finalMessage: scenario?.message ?? '',
            filesTouched: Object.keys(files),
            reason: scenario?.reason ?? 'stop',
            telemetry: {},
          };
        },
        kill: () => Promise.resolve(),
      };
      return worker;
    },
  };
}
