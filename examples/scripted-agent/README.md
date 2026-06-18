# scripted-agent — the agent path, deterministically

The same conductor, now driving *agent* work — a `{prompt}` node plus a
**cross-provider audit** — but with a **scripted runner** in place of a real
agent CLI. It runs with no LLM, no API keys, and no `umbel`/tmux: the runner
applies canned worktree changes and returns a passing audit, so the full gate
ladder executes deterministically (and in CI).

It demonstrates the part `command-dag` can't:

| node | work | shows |
|------|------|-------|
| `implement` | prompt → writes `wc.ts`, then a **codex** audit | agent work gated by a **different-vendor** auditor before it verifies |
| `harden` (needs `implement`) | prompt → writes `wc.test.ts`, audited | a dependent builds on the **verified** output of the first node |

The cross-provider rule still holds: each node is built as `claude` (the
default) and audited as `codex` — a model never grades its own family's work.

## How the runner plugs in

[`pleach.config.ts`](./pleach.config.ts) exports a `{ runner, ledger }`. The
runner is the only thing that changes between "deterministic demo" and "real
agents":

```ts
export default {
  runner: scriptedRunner([ /* canned per-prompt changes + a passing audit */ ]),
  ledger: gitLedger(),
} satisfies PleachConfig;
```

Swap `scriptedRunner(...)` for `umbelRunner(...)` (or your own `RunnerSeam`) and
the identical plan runs against real agents — the plan, gates, and ledger are
unchanged.

## Run it

```bash
repo=$(mktemp -d)
git -C "$repo" init -q
echo init > "$repo/init.txt"
git -C "$repo" add -A
git -C "$repo" commit -q -m init

( cd "$repo" && pleach run "$OLDPWD/examples/scripted-agent/plan.json" \
    --config "$OLDPWD/examples/scripted-agent/pleach.config.ts" )
```

Both nodes close (verified, audited) and are published as `node/implement` and
`node/harden`. `gitLedger()` resolves its repo from the working directory, so
the run happens from inside `$repo`.
