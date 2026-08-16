# Three ways to run pleach

The same tic-tac-toe build, conducted three ways. pleach's job never changes — isolate
each plan node, enforce the gates, publish a `node/<id>` branch only for verified work.
What changes between these profiles is **how the agent is reached** and **where the
ledger lives**. The plan is the constant; the runner is the variable.

## The idea

A *runner* is a mechanism for reaching a code-editing agent. There are exactly three:

1. **drive its interactive CLI** over a terminal multiplexer (umbel → tmux),
2. **spawn its headless CLI** as a subprocess (`claude -p` / `codex exec`),
3. **call its in-process SDK** (the Agent SDK — no subprocess).

Each proof below is one of those mechanisms, wired into a coherent profile. The build
(the [shared payload](./payload/)) and the cross-provider audit are identical across all
three — only the profile around them changes.

## The profiles

| | profile | runner | build → audit | ledger / audit | invocation | battle-tests | who can run |
|---|---|---|---|---|---|---|---|
| **0** | scripted backbone | scripted (no agent) | canned | git / canned | e2e | the plan + loop + merge + audit egress, deterministically | **CI** |
| **1** | [the strict rig](./01-umbel/) | umbel (tmux) | claude → codex | tend / `tend audit` | CLI | the **verifier** (negctrl, honest-middle) | full plotplot stack |
| **2** | [bring your own runner](./02-direct-cli/) | direct-CLI (headless) | claude → codex | git / `git-audit.sh` | CLI | the **runner port** + standalone substrate | anyone w/ claude+codex |
| **3** | [embed the conductor](./03-library/) | Agent SDK (in-process) + CLI | claude → codex | git / `git-audit.sh` | **library** + resume | the **programmatic surface** | anyone w/ claude+codex+SDK |

## Which profile is you?

- **"I want maximum rigor with interactive agents"** → **proof 1**. tend's discriminating
  audit is the strictest close criterion pleach has.
- **"I want to run lean on git, no umbel"** → **proof 2**. The bundled direct-CLI
  adapter (`pleach run --runner direct-cli`) — a ~40-line runner is the whole
  integration surface if you bring your own.
- **"I want to embed pleach in my own app or tool"** → **proof 3**. `buildDeps` + `runPlan`
  from your code, consume the typed result, resume for free.

## Proof vs. test — read this

Profiles 1–3 drive **real agents**. They are **proof runs / demos**: non-deterministic
(the agent writes the code its own way each run), they need API keys or a subscription,
and you run them by hand. They prove the *integration boundaries* hold with real tools.

The **deterministic guardrail is case 0** —
[`test/e2e/three-ways.test.ts`](../../test/e2e/three-ways.test.ts) runs the exact same
plan through the bundled scripted runner (canned diffs, no agent, no keys) and asserts a
full verified close plus the `node/*` branches, in CI. That is the part that cannot
silently rot. The three real-agent proofs are runner-swaps on top of it.

## The cross-provider audit, precisely

In every profile the audit is a **deterministic command run in an independent,
different-vendor session** — `tend audit` (proof 1) or `git-audit.sh` (proofs 2/3). The
auditor agent runs the command and reproduces its verdict block verbatim; pleach parses
that block, **never the agent's prose**. The cross-provider guarantee is *execution
isolation* (a fresh, different-vendor session runs the check), not model judgment. tend
adds negctrl discrimination on top of a green suite; `git-audit.sh` is the lighter
standalone version — and that difference is proof 1's lesson.

## The shared payload

[`payload/`](./payload/) — a tic-tac-toe engine, built as a 3-node DAG:

| node | builds (test-first) |
|---|---|
| `ttt.s1` ∥ | `legalMoves` · `applyMove` |
| `ttt.s2` ∥ | `winner` |
| `ttt` (needs both) | merge s1 + s2, add `status` · `play` — then the cross-provider audit |

Pure, deterministic, crisp assertions. Both `ttt.s1` and `ttt.s2` edit `src/ttt.ts`, so
the integration node resolves a real merge before it builds — every profile exercises that.

## Play it

A proof run produces a self-contained `index.html` in the throwaway repo — the verified
web game the agents built. Open it in a browser to play: it has inline HTML/CSS/JS with
no external imports, so it needs no build step or server (any static server works if your
browser blocks `file://`).
