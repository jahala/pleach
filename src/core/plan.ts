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
  id: z.string()                                            // v1.1.1: dot-separated alnum/_/- segments — legal as a git
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/)  // refname + shell-safe; '.' is the composite separator
    .refine((s) => !s.endsWith('.lock'), 'git refuses refname components ending .lock'),
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
      // OPTIONAL — pin the auditor's model; the provider still MUST differ (diversity).
      model: z.string().optional(),
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
    blockedReason: z.string().optional(),                   // v1.1.1: the blocking prompt text when status === 'blocked'
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
