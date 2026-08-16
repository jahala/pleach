# Extending pleach: adapters and contracts

pleach is the deterministic conductor between a feature ledger and an execution boundary. It
takes a validated Plan (a DAG of nodes), isolates each node in a detached git worktree merged
from its dependencies' verified branches, enforces gates (conflict-marker scan, smoke command,
cross-provider audit), and publishes a `node/<id>` branch only for verified work.

To pair pleach with your own tools, you implement at most **two small adapters**. The
isolation layer, gate logic, git worktree lifecycle, and commit-before-emit invariant are
pleach's own code — they are not pluggable and do not change. The integration surface is:
one data contract (the plan) plus two code seams (runner, ledger).

---

## The three integration points

| Role | What it does | How it integrates | pleach calls it? |
|---|---|---|---|
| **Plan source** (planner) | Emits the DAG of work pleach will run | Data contract — a `plan.json` file | No — you produce it; pleach reads it |
| **Runner** (executor) | Spawns and drives an interactive agent per node | `RunnerSeam` interface — runtime injection | Yes — once per node (plus once per audit node) |
| **Ledger** (verifier) | Tracks closed nodes; decides whether a `done` verdict is verified | `LedgerSeam` interface — runtime injection | Yes — `readClosed` at startup; `emitVerdict` per node |

---

### Plan source

Emit a `plan.json` whose schema conforms to `@agent-contract/plan`.
The canonical specification lives in [`docs/contract/plan-schema.md`](contract/plan-schema.md).

Two commands let you check conformance without running the loop:

```
pleach validate <plan.json>   # validates and prints precise typed errors; exit 1 on failure
pleach schema                 # emits the JSON Schema — feed it to an LLM or a codegen tool
```

The planner is completely decoupled. tend's polyglot exporter is one implementation; an LLM
that emits a plan over a set of GitHub issues is another; a hand-authored JSON file is a third.
pleach never calls the planner.

Key fields to note from `src/core/plan.ts`:

```ts
// Plan — the top-level input
const Plan = z.object({
  goal: z.string(),
  source: z.string(),          // the tend polyglot — the DURABLE home; ledger key
  maxConcurrency: z.number().int().positive().optional(),
  nodes: z.array(Node),
});

// Node — one unit of work
const Node = z.object({
  id: z.string(),              // dot-separated, git-safe, shell-safe
  worker: z.object({
    provider: z.string().optional(),
    model: z.string().optional(),
    cwd: z.string().optional(),
  }).default({}),
  work: Work,                  // prompt | test-cycle | command
  setup: z.string().optional(),
  needs: z.array(z.string()).default([]),
  accept: z.object({
    smoke: z.string().optional(),
    audit: z.object({
      command: z.string(),     // e.g. `tend audit <feature>`
      provider: z.string(),    // MUST differ from worker.provider
    }).optional(),
  }).default({}),
  policy: z.object({
    maxAttempts: z.number().int().default(2),
    timeoutMs: z.number().int().positive().optional(),
    onDead: z.enum(['resume', 'fail']).default('resume'),
    // ...
  }).prefault({}),
  closes: z.array(z.string()).default([]),  // ledger metadata; loop does not consume
});
```

`plan.source` is the durable key the ledger uses to scope `readClosed` and `emitVerdict`
calls. For tend-backed plans it is the feature polyglot path; for other planners it can be
any stable string that identifies the plan's origin.

`node.worker.provider` selects the runner's provider per node, making plans portable
across tool configurations — the same plan runs whether the config wires umbel or another
runner.

---

### Runner adapter (`RunnerSeam`)

The full interface, from `src/loop/deps.ts`:

```ts
export interface RunnerSeam {
  spawnWorker(spec: { provider?: string; model?: string; cwd: string }): Promise<Worker>;
}

export interface Worker {
  send(text: string): Promise<void>;
  wait(opts?: { timeoutMs?: number }): Promise<WorkerResult>;
  kill(): Promise<void>;
}

export interface WorkerResult {
  // Read UNTRUNCATED — audit-result egress depends on it (ledger C4).
  finalMessage: string;
  actions?: unknown;
  diff?: string;
  filesTouched: string[];
  exitCode?: number;
  reason?: 'stop' | 'dead' | 'timeout' | 'aborted' | 'input' | 'idle';
  // The blocking prompt text when reason is input/idle — carried into Verdict.evidence.blockedReason.
  message?: string;
  telemetry: { tokens?: number; contextPct?: number; compacted?: boolean };
}
```

**What "umbel-like" means.** The `RunnerSeam` contract describes an interactive agent you
drive via a send→wait→kill cycle:

1. `spawnWorker` starts an agent session in the given `cwd` (which pleach has already
   prepared as an isolated git worktree).
2. `send` delivers one prompt to the agent.
3. `wait` blocks until the agent produces a terminal event, then returns a `WorkerResult`.
4. `kill` tears down the session. pleach always calls `kill` after `wait` returns,
   regardless of outcome.

The `reason` field is the full taxonomy of terminal events:

| `reason` | Meaning | pleach's action |
|---|---|---|
| `'stop'` | Agent finished cleanly and produced output | Read `finalMessage`, stage files, run gates |
| `'dead'` | Agent process exited unexpectedly | Retry or fail per `onDead` policy |
| `'timeout'` | `wait` timed out | Retryable — reuse tree, re-prompt with evidence |
| `'aborted'` | Session cancelled | Terminal failure |
| `'input'` | Agent is waiting at a permission/approval prompt | Kill + dispose; Verdict `status:'blocked'` with the prompt text as `blockedReason` — the operator fixes the permission mode and re-runs |
| `'idle'` | Agent stalled without a permission prompt | Kill + dispose; Verdict `status:'blocked'` — the operator re-runs |

**Runner post-condition (verified from `src/loop/run-node.ts:191–194`).** When `wait()`
returns `reason: 'stop'`, the runner is expected to have populated the working tree with
the agent's output — but it does NOT need to stage or commit anything. pleach calls
`isolate.changedFiles(cwd)` to enumerate all tracked modifications and untracked-unignored
files in the worktree, unions that with `result.filesTouched` from the worker manifest, and
calls `isolate.stage(cwd, stagedFiles)` itself. The commit to `node/<id>` is entirely
pleach's.

```ts
// src/loop/run-node.ts:191-194
const changed = await deps.isolate.changedFiles(cwd);
const stagedFiles = dedup([...result.filesTouched, ...changed]);
await deps.isolate.stage(cwd, stagedFiles);
```

`result.filesTouched` is the hint the adapter provides (e.g. from `umbel actions --json`);
`changedFiles` is pleach's own fallback scan. Either path works: if your adapter cannot
enumerate touched files precisely, return `filesTouched: []` and pleach's git status scan
covers the rest. If your agent is self-committing (e.g. aider), the adapter must normalize
its output to this post-condition: **undo any commits the agent made and leave the changes
staged or unstaged in the working tree** before `wait()` resolves, so pleach's staging
and `commitBranch` call produce the canonical `node/<id>` commit.

---

### Ledger adapter (`LedgerSeam`)

The full interface, from `src/loop/deps.ts`:

```ts
export interface LedgerSeam {
  // id → verified commit SHA; null when the ledger has no SHA recorded.
  // The SHA is the durable resume base (ledger B1).
  readClosed(source: string): Promise<Map<string, string | null>>;
  emitVerdict(v: Verdict, source: string): Promise<{ closed: boolean }>;
}
```

`readClosed` is called once at plan startup (before any node runs) and returns all previously
verified node ids for this plan source. The SHA value — when present — is the commit pleach
will use as the base ref for dependent nodes if the `node/<id>` branch has been GC'd or is
unavailable. Returning `null` for an id is valid (legacy / external verification with no
SHA recorded); pleach falls back to searching the git refstore.

`emitVerdict` is called after each node reaches a terminal state. It must decide
**synchronously** (no blocking on a human). Return `{ closed: true }` to mark the node
verified; `{ closed: false }` to decline (the node's branch is still published, but
dependents are skipped and the run summary records it as `partial`). For non-audit nodes,
pleach ignores `emitVerdict`'s return value and closes unconditionally (`run-plan.ts:230`):
`const shouldClose = node.accept.audit ? decision.closed : true;` — so your ledger's
`closed` flag is only consequential for nodes that carry an `accept.audit` block.

`gitLedger` is the trivial reference: `readClosed` lists `node/*` branches in the local
repo, **scoped to the plan source** — pleach writes `source: <plan.source>` into every
node commit, and only branches carrying that exact line count as this plan's verified
work (two plans sharing a repo cannot cross-resume; a hand-made `node/*` branch is never
trusted). `emitVerdict` returns `{ closed: verdict.status === 'done' }`. It is entirely
local and requires no external service.

---

## The config model

`src/faces/config.ts` exports:

```ts
export interface PleachConfig {
  runner: RunnerSeam;
  ledger: LedgerSeam | Promise<LedgerSeam>;
}
```

`resolveSeams` resolves a runner and ledger in this precedence order:

1. **`--config <path>`** — if given, loads exactly that file (and errors if it is absent).
2. **`pleach.config.ts` at the repo root** — used when no `--config` is given. If present, its
   default export must be a `PleachConfig`; both `runner` and `ledger` must be non-null objects,
   else `ConfigError`.
3. **Zero-config default** — neither of the above present: `umbelRunner` + either `tendLedger`
   (when `--tend-module` is supplied) or `gitLedger`. The `--umbel-bin` and `--permission-mode`
   flags thread into the default runner.

A minimal `pleach.config.ts` using the bundled adapters:

```ts
import { umbelRunner } from 'pleach/adapters/umbel';
import { gitLedger } from 'pleach/adapters/git';
import type { PleachConfig } from 'pleach/config';

export default {
  runner: umbelRunner({ bin: 'umbel', permissionMode: 'bypassPermissions' }),
  ledger: gitLedger({ repo: '.' }),
} satisfies PleachConfig;
```

Swapping in a different runner (e.g. one backed by the Anthropic API directly rather than
umbel/tmux) requires only changing the `runner` line. The plan does not change: `worker.provider`
names the provider the plan expects, and the config decides how that provider is reached.

**Plan vs. config separation.** `worker.provider` in the plan is intent; the config is
tooling. A plan that says `provider: 'codex'` runs under any runner that can dispatch to
codex — umbel, a hypothetical cloud runner, or a test double. Plans stay portable across
environments; configs are environment-specific.

---

## The cross-provider audit egress

When a node carries an `accept.audit` block, pleach spawns a second agent using
`audit.provider` (which must differ from `worker.provider` — provider diversity is a
preflight invariant enforced before any spawn). The auditor is sent a prompt constructed by
`buildAuditPrompt` (from `src/core/audit-egress.ts`) that wraps `audit.command` with
machine-readable extraction instructions.

The auditor must reproduce the command's output as a fenced block in its reply message:

````
```tend-audit-result
{ ... }
```
````

The fence label is `tend-audit-result` (constant `FENCE_LABEL` in `src/core/audit-egress.ts`,
line 9). This label is pleach's egress contract; the name is historically tend-specific but
applies to any auditor. `extractAuditJson` finds the **last** block so labelled in
`finalMessage` (read untruncated, ledger C4) and parses it. If no such block is present or
the content is not valid JSON, pleach re-runs the auditor up to `REAUDIT_BUDGET` (2) times
before failing the node.

The parsed JSON must match `AuditResult` from `src/core/plan.ts`:

```ts
const AuditResult = z.object({
  verdicts: z.array(z.object({
    check: z.string(),
    verdict: z.enum(['pass', 'partial', 'fail']),
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
});
```

The tend-specific fields (`negctrl`, `evidencePath`, `evidenceSha`, `validatesJobSatisfied`)
are all `.optional()`. A non-tend auditor emits only the required minimum:

```json
{
  "verdicts": [
    { "check": "my-check-id", "verdict": "pass", "reasons": ["all assertions green"] }
  ]
}
```

A `verdict: 'fail'` on any check triggers a retryable re-prompt of the build worker with
the failing `reasons[]` as evidence — up to `maxAttempts`. A `verdict: 'partial'` is
pleach's honest-middle: the audit passed but the ledger (e.g. tend) declined to
verify-close. The node's branch is still published; its dependents are skipped.

---

## Bundled adapters

Five adapters ship in `src/adapters/` as the batteries-included configuration:

- **`umbelRunner`** (`src/adapters/umbel.ts`) — `RunnerSeam` backed by the `umbel` binary
  over tmux. Drives claude, codex, and gemini workers through spawn/send/wait/read/kill
  verbs. The public factory: `umbelRunner(opts: UmbelSeamOpts): RunnerSeam`.

- **`directCliRunner`** (`src/adapters/direct-cli.ts`) — `RunnerSeam` over headless agent
  CLIs (`claude -p`, `codex exec`) as one-shot subprocesses; no umbel, no tmux. Selected
  with `pleach run --runner direct-cli` or imported in a config. Single-turn `{prompt}`
  work only (a second `send` throws — `{phases}` needs session resumption; use umbel).
  Its argv table tracks external CLIs and is pinned by unit tests so drift breaks CI —
  the installed CLI versions are your substrate responsibility. The public factory:
  `directCliRunner(opts?: DirectCliOpts): RunnerSeam`.

- **`scriptedRunner`** (`src/adapters/scripted.ts`) — deterministic no-LLM `RunnerSeam`
  driven by canned scenarios; the CI backbone for example plans and a template for
  test doubles. The public factory: `scriptedRunner(scenarios): RunnerSeam`.

- **`tendLedger`** (`src/adapters/tend.ts`) — `LedgerSeam` backed by tend's ingester module.
  Wraps the transport in a serial promise-chain queue (single-ingester invariant). Accepts a
  `Set<string>` (pre-T1 tend) or `Map<string, string | null>` (T1+) from `readClosed`.
  The public factory: `async tendLedger(opts: { module: string }): Promise<LedgerSeam>`.

- **`gitLedger`** (`src/adapters/git.ts`) — trivial `LedgerSeam` backed by `node/*` branches
  in the local git repo. Zero external dependencies; `emitVerdict` is pure (`{ closed: verdict.status === 'done' }`).
  The public factory: `gitLedger(opts?: GitLedgerOpts): LedgerSeam`.

The zero-config default wires `umbelRunner` + `gitLedger` (or `tendLedger` when
`--tend-module` is given). This is the standalone "run and verify locally" configuration.

---

## Boundaries (honest)

pleach conducts **local executors** over git worktrees. It is not a cloud agent orchestrator:
the runner must be a process pleach can spawn locally (umbel/tmux, or a local API wrapper).
Cloud-autonomous agents that accept work and return a result asynchronously (e.g. Devin,
Claude Code in headless mode with no shell) require an adapter that bridges their async
protocol into the sync send→wait→kill contract — doable, but the adapter owns that
translation.

Verification must be **automatable**. A `LedgerSeam` whose `emitVerdict` blocks waiting for
a human to approve does not fit the autonomous loop: pleach cannot wait indefinitely for an
external decision after committing a branch. The ledger decides deterministically from the
`Verdict` it receives. Gating on human review is better modelled as a `blocked` worker
outcome (the human unblocks the agent session) or a post-run CI step that re-runs pleach
with the human's approval reflected in the ledger's closed set.
