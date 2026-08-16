# Proof 2 — bring your own runner

**Perspective: the runner port is open.** No umbel, no tmux, no tend — a single
readable file drives real agents to the same verified close as the full rig, on plain
git.

## What it shows

- [`../lib/direct-cli-runner.ts`](../lib/direct-cli-runner.ts) is a complete
  `RunnerSeam`. Its core — an argv table plus a spawn-and-capture worker — is about
  40 lines (the rest is the doc comment and the injected seams that make it
  unit-testable). It shells `claude -p` for each build node and `codex exec` for the
  cross-provider audit, captures stdout + the git diff, and hands pleach a
  `WorkerResult`. That is the **entire** integration surface: write that, and every
  pleach guarantee — isolation, the gate ladder, quarantine, the cross-provider
  audit — works unchanged.
- `gitLedger` records the verified close as `node/*` branches. The branches **are**
  the ledger; no tend, no database.
- The audit is just a command — [`../payload/project/git-audit.sh`](../payload/project/git-audit.sh)
  — run in an independent, different-vendor session. pleach parses the verdict block
  it prints, never the agent's prose. The cross-provider guarantee is *execution
  isolation*, not model judgment. (Proof 1 swaps this for `tend audit`, which adds
  negctrl discrimination on top.)

## Run it

Requires `claude` + `codex` CLIs on PATH (logged in), plus `bun` and `git`. No umbel,
no tend.

```bash
bash run.sh
```

It copies the tic-tac-toe payload into a throwaway git repo and runs the shared plan
([`../payload/plan.json`](../payload/plan.json)) through the direct-CLI runner.

## What success looks like

A JSON `RunSummary` on stdout with all three nodes closed:

```json
{"closed":["ttt.s1","ttt.s2","ttt"],"failed":[],"partial":[],"skipped":[],"blocked":[]}
```

and three `node/*` branches in the repo. Each branch holds verified work: the build
passed its smoke gate, the `ttt.s1` ⊕ `ttt.s2` merge resolved cleanly, and the codex
audit returned `pass`.

If a build node can't satisfy its gate, pleach retries (`policy.maxAttempts`) and then
**quarantines** it — no branch, and its dependent is skipped. That holds whatever the
runner: garbage can't propagate down the DAG.

## The takeaway

You are not locked to umbel. The `RunnerSeam` is the whole contract, and a headless
CLI wrapper satisfies it. Copy `../lib/direct-cli-runner.ts`, confirm the argv flags
against your installed CLI versions, and pleach runs on your stack.

## Play it

The proof run produces a self-contained `index.html` in the throwaway repo — the verified
web game, bundled with inline HTML/CSS/JS and no external imports. Open it in a browser;
no build step or server required (any static server works if your browser blocks `file://`).
