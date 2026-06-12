# `@agent-contract/plan` v1.1 — canonical text

This repo is the contract's home. `src/core/plan.ts` must match the fenced block below byte-for-byte
(drift-tested). tend and rctrl vendor from this file. Schema changes happen here first — doc + source +
drift test in one commit, with an entry in [`CHANGES.md`](CHANGES.md).

Provenance: v0.3 §1 of `tend-rctrl-build-spec.md` (ratified) + the v1.1 verification deltas
(`docs/ledger.md`): id charset (SEC3), `setup` (C3), `policy.timeoutMs` (D1), `Verdict.status +=
'blocked'` (D2), inert-field annotations (D6), `diffRef` required-on-close (B1/B2). Proposed to the tend
side in `missoula/docs/internal/bridge/plan-schema-v1.1-proposed.md`; amendments from their ratification
response land here as v1.1.x entries.

```ts
import { z } from 'zod';

const Work = z.union([
  z.object({ prompt: z.string() }),                         // agent, single send/wait
  z.object({
    test: z.string(),                                       // command the phase-gates run (RED must fail, GREEN must pass)
    phases: z.array(z.object({
      phase: z.enum(['red', 'impl', 'green']),
      prompt: z.string(),                                   // tend: the Test: / Implement: prose
    })),
  }),                                                       // agent, test-cycle (v2)
  z.object({ command: z.string() }),                        // command/worktree — exit-code gated, no test wrap
]);

const Node = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),    // v1.1: interpolated into git refs + shell — charset enforced
  worker: z.object({
    provider: z.string().optional(),
    model: z.string().optional(),
    cwd: z.string().optional(),                             // usually filled by isolate()
  }).default({}),
  work: Work,
  setup: z.string().optional(),                             // v1.1: run once post-isolate (dep install) before work + gates
  needs: z.array(z.string()).default([]),                   // tend: step.deps ∪ feature.deps — ordering AND file-flow edges
  accept: z.object({
    smoke: z.string().optional(),                           // exit 0 = pass (layer 1)
    audit: z.object({
      command: z.string(),                                  // e.g. `tend audit <feature>` (intent-read + negctrl)
      provider: z.string(),                                 // MUST ≠ worker.provider — model diversity
    }).optional(),
  }).default({}),
  policy: z.object({
    maxAttempts: z.number().int().default(2),
    timeoutMs: z.number().int().positive().optional(),      // v1.1: per-attempt wall clock — wait() AND every exec()
    onDead: z.enum(['resume', 'fail']).default('resume'),
    reauditWhen: z.array(z.enum(['compacted', 'retried', 'context-hot'])).default(['compacted']),  // v1-inert until telemetry
    budget: z.object({ tokens: z.number().optional(), usd: z.number().optional() }).optional(),    // v1-inert (unenforced)
  }).prefault({}),
  closes: z.array(z.string()).default([]),                  // tend: traces_to — ledger metadata; the loop does not consume it
});

const Plan = z.object({
  goal: z.string(),
  source: z.string(),                                       // the tend polyglot — the DURABLE home
  maxConcurrency: z.number().int().positive().optional(),   // conductor defaults to cores-2 (schema stays os-free)
  nodes: z.array(Node),
});

const Verdict = z.object({
  node: z.string(),
  status: z.enum(['done', 'failed', 'dead', 'timeout', 'rejected', 'aborted', 'blocked']),  // v1.1: +blocked (held at a prompt) — mechanical, no `verified`
  output: z.unknown(),                                      // audit nodes: an AuditResult
  evidence: z.object({
    traceRef: z.string().optional(),
    diffRef: z.string().optional(),                         // v1.1: verified commit SHA — REQUIRED on close (resume base, ledger B1/B2)
    filesTouched: z.array(z.string()).default([]),
    gate: z.object({ ran: z.string(), exitCode: z.number() }).optional(),
  }),
  telemetry: z.object({
    tokens: z.number().optional(),
    contextPct: z.number().optional(),
    compacted: z.boolean().optional(),                      // [ROADMAP] empty v1 → reauditWhen dormant-but-safe
  }).default({}),
  attempts: z.number().int(),
});

const AuditResult = z.object({
  verdicts: z.array(z.object({
    check: z.string(),                                       // tend: check_id (adapter maps)
    verdict: z.enum(['pass', 'partial', 'fail']),            // three-valued — partial is tend's honest-middle
    negctrl: z.object({ ran: z.boolean(), discriminated: z.boolean() }).optional(),
    evidencePath: z.string().optional(),
    evidenceSha: z.string().optional(),
    validatesJobSatisfied: z.boolean().nullable().optional(),
    reasons: z.array(z.string()).default([]),
  })),
  drift: z.array(z.object({
    finding: z.string(),
    file: z.string().optional(),
    action: z.enum(['implement', 'investigate', 'document']).optional(),
  })).default([]),
  // NO agent-authored `result` — the ingester derives it (§4).
});

export type Plan = z.infer<typeof Plan>;
export type Node = z.infer<typeof Node>;
export type Verdict = z.infer<typeof Verdict>;
export type AuditResult = z.infer<typeof AuditResult>;
export { Plan as PlanSchema, Node as NodeSchema, Verdict as VerdictSchema, AuditResult as AuditResultSchema };
```

## Seam interfaces (informative — code home is `src/loop/deps.ts`)

```ts
export interface TendSeam {
  readClosed(source: string): Promise<Map<string, string | null>>;   // id → verified commit SHA (null = legacy)
  emitVerdict(v: Verdict, source: string): Promise<{ closed: boolean }>;
}
export interface RctrlSeam {
  spawnWorker(spec: { provider?: string; model?: string; cwd: string }): Promise<Worker>;
}
export interface Worker {
  send(text: string): Promise<void>;
  wait(opts?: { timeoutMs?: number }): Promise<WorkerResult>;
  kill(): Promise<void>;
}
export interface WorkerResult {
  finalMessage: string;                       // read UNTRUNCATED — audit egress depends on it
  actions?: unknown;
  diff?: string;
  filesTouched: string[];
  exitCode?: number;
  reason?: 'stop' | 'dead' | 'timeout' | 'aborted' | 'input' | 'idle';
  telemetry: { tokens?: number; contextPct?: number; compacted?: boolean };
}
```
