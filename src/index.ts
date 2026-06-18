// Library entry — the programmatic surface of pleach. Import this to run a plan
// in-process instead of shelling out to the CLI (the `pleach` binary is
// src/main.ts). The package "." export points here, not at the CLI bootstrap,
// so importing the package never parses argv or calls process.exit.
//
//   import { runPlan, buildDeps } from 'pleach';
//   import { gitLedger } from 'pleach/adapters/git';
//   import { scriptedRunner } from 'pleach/adapters/scripted';
//
//   const deps = buildDeps({ repoRoot, runner: scriptedRunner([...]), ledger: gitLedger() });
//   const summary = await runPlan(plan, deps, { repoRoot });

export * from './core/errors.ts';
export type { AuditResult, Node, Plan, Verdict } from './core/plan.ts';
export { AuditResultSchema, NodeSchema, PlanSchema, VerdictSchema } from './core/plan.ts';
export { planJsonSchema } from './core/schema-json.ts';
export type { NodeSummary } from './core/validate.ts';
export { nodeSummaries, validatePlan } from './core/validate.ts';
export type { BuildDepsOpts, PleachConfig, ResolveSeamsOpts } from './faces/config.ts';
export { buildDeps, resolveSeams } from './faces/config.ts';
export type {
  ConductorDeps,
  ExecFn,
  ExecResult,
  IsolateSeam,
  Isolation,
  JournalSeam,
  LedgerSeam,
  LockHandle,
  LockSeam,
  RunnerSeam,
  RunSummary,
  Worker,
  WorkerResult,
} from './loop/deps.ts';
export { runPlan } from './loop/run-plan.ts';
