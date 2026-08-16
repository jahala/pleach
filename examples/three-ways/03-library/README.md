# Proof 3 — embed the conductor

**Perspective: pleach as a library, with an in-process agent.** Your own program runs
*both* the conductor (pleach via `buildDeps` + `runPlan`) and the build agent (the
Claude Agent SDK, in-process — no subprocess, no tmux). The fully-embedded profile:
everything in one process, and you consume the structured result directly instead of
parsing CLI stdout.

## What it shows

- **The library surface.** [`run.ts`](./run.ts) loads the shared plan, assembles deps
  with `buildDeps({ repoRoot, runner, ledger })`, calls `runPlan`, and asserts on the
  typed `RunSummary` — no `pleach` binary, no stdout parsing.
- **A composite runner — the right mechanism per provider.** The claude build runs
  in-process via the Agent SDK's `query()`; the codex cross-provider audit reuses the
  headless CLI runner from [proof 2](../02-direct-cli/). One `RunnerSeam`, two
  mechanisms, dispatched on `spec.provider`. This is the genuine third way to reach an
  agent: not its terminal (proof 1) or its subprocess (proof 2), but its loop **inside
  your process**.
- **Resume.** `run.ts` runs the plan **twice**. The second run rebuilds nothing — every
  node returns in `summary.alreadyVerified`. Re-running is idempotent; the ledger's
  verified `node/*` branches are the resume base.

## Run it

From the **pleach repo root** (so `pleach` self-resolves):

```bash
bun add @anthropic-ai/claude-agent-sdk          # example-only dep — NOT part of pleach
ANTHROPIC_API_KEY=... bun examples/three-ways/03-library/run.ts
```

Requires an Anthropic API key (for the SDK build) and the `codex` CLI on PATH (for the
audit). No umbel, no tend.

## What success looks like

```
run 1:         {"closed":["ttt.s1","ttt.s2","ttt"],"failed":[],"partial":[],"skipped":[],"blocked":[],"alreadyVerified":[]}
run 2 (resume): {"closed":[],"failed":[],"partial":[],"skipped":[],"blocked":[],"alreadyVerified":["ttt.s1","ttt.s2","ttt"]}
✓ embedded run reached a verified close, and resume skipped every node.
```

`run.ts` throws if the close or the resume doesn't hold — the demo is self-verifying.

## A note on the SDK call

The `query()` call in `run.ts` is **illustrative** — confirm its exact shape against
your installed `@anthropic-ai/claude-agent-sdk` version (the Agent SDK evolves), the
same way proof 2's CLI flags are version-specific. The pleach-side code (`buildDeps`,
`runPlan`, the `RunnerSeam`/`Worker` contract) is the stable, load-bearing part — that
is what this proof is really testing.

## The takeaway

pleach is a library, not just a CLI. Embed it, drive any runner — even an in-process
agent loop — consume the typed `RunSummary`, and trust that re-running resumes. The
conductor lives inside your app.

## Play it

The proof run produces a self-contained `index.html` in the throwaway repo — the web game
your embedded agent wrote, with inline HTML/CSS/JS and no external imports. Open it in a
browser to play; no build step or server needed (any static server works if your browser
blocks `file://`).
