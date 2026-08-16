# Proof 1 — the strict rig

**Perspective: the verifier.** umbel drives real claude builders and a real codex
auditor over tmux; a standalone discriminating audit (`strict-audit.sh`) runs the
negctrl. This is the maximal profile — every gate is live, and "verified" is earned
by negctrl discrimination, not granted by a passing test. No tend instance required.

## What it shows

- **umbel as the runner.** Each build node (`ttt.s1`, `ttt.s2`, the integration
  `ttt`) runs as a persistent interactive claude session in a tmux pane. umbel
  spawns the session, sends the prompt, waits for completion, and hands pleach a
  `WorkerResult` with the git diff. pleach never touches tmux directly — umbel is
  the entire `RunnerSeam` implementation.

- **A standalone discriminating audit.** The integration node's accept gate is
  `bash strict-audit.sh ttt` (codex provider). `strict-audit.sh` runs `bun test`
  to confirm the suite passes, then runs a negative control: it mutates `src/ttt.ts`
  (making `winner()` always return `null`) and re-runs. A suite that discriminates
  must now go red; if it stays green the audit caps at `partial`. The source is
  always restored (trap). This is the same negctrl principle that tend uses at the
  ledger — implemented in ~20 lines of bash so proof 1 needs no missoula/tend
  instance. tend is the production-grade version; `strict-audit.sh` is the
  self-contained proof.

- **The honest-middle, in both directions.** A non-discriminating test caps the
  feature at `partial` — pleach publishes the `node/ttt` branch but does NOT mark
  the node verified; the run summary reports it in `partial`, not `closed`. Only
  when every check both passes and discriminates does the feature reach `verified`.
  No special-casing, no escape hatch. The same guardrail fires in both directions:
  a tautological test is caught just as surely as a failing one.

- **Cross-provider model diversity.** The claude builders write the code; the
  codex auditor executes `strict-audit.sh` and relays the `tend-audit-result` fence
  verbatim. pleach parses that fence — never the agent's prose. The cross-provider
  guarantee is execution isolation, not model judgment.

## This profile is already proven end-to-end

[`examples/proof/`](../../../examples/proof/) is the PROVEN reference run:
real claude builders + a real codex auditor + real tend, on the wordcount payload.
[`docs/research/proof-run.md`](../../../docs/research/proof-run.md) records the
full execution history:

- **Run 2** capped at `partial` when c2 had no negctrl — the honest-middle
  working exactly as designed, confirmed in production.
- **Run 3** reached a full `verified` close once every check had a discriminating
  negctrl.

That proof run used tend as the verifier (the production-grade path). Proof 1
re-skins the same rig to the shared ttt payload, replacing the tend gate with
`strict-audit.sh` — the same negctrl principle, no missoula instance required.
The code path through pleach (umbel runner + gitLedger + gate ladder) is identical.

## Prerequisites

You need:

- `umbel` on PATH (or `UMBEL_BIN` env var set to its location)
- `tmux` (umbel's substrate)
- `bun` on PATH
- `jq` on PATH (to swap the audit command at run time)
- `claude` and `codex` CLIs, both logged in
- No tend. No missoula. `strict-audit.sh` ships in the starter project.

## Run it

From the pleach repo root:

```bash
bash examples/three-ways/01-umbel/run.sh
```

The script seeds a throwaway git repo from
[`../payload/project/`](../payload/project/) (which includes `strict-audit.sh`),
then uses `jq` to derive the plan from
[`../payload/plan.json`](../payload/plan.json) with the audit command swapped to
`bash strict-audit.sh ttt`, and runs the conductor against the derived plan.

## What success looks like

```json
{"closed":["ttt.s1","ttt.s2","ttt"],"failed":[],"partial":[],"skipped":[],"blocked":[]}
```

and three `node/*` branches in the throwaway repo. Each branch holds verified
work: the build passed its smoke gate, the `ttt.s1` ⊕ `ttt.s2` merge resolved
cleanly, and the codex auditor ran `strict-audit.sh ttt` with the negctrl
discriminating.

If a build node can't satisfy its smoke gate, pleach quarantines it — no branch,
and the `ttt` integration node is skipped. If the discriminating audit reaches
`partial` (the negctrl didn't discriminate), pleach publishes the branch but reports
the node as `partial`, not `closed`. Both behaviors are guardrails, not bugs.

## The takeaway

"verified" is a statement about discrimination, not just about passing. A strict
audit requires a real test that runs green AND a negctrl that proves the test would
fail if the code were wrong. `strict-audit.sh` implements that in ~20 lines of bash
— no tend instance needed. umbel gives pleach a persistent, interactive agent
session, and the discriminating audit gives it an evidence-based close criterion.
tend is the production-grade version of the same principle (integrated with the
feature ledger); proof 1 shows the bundled umbel + git adapters carry the full
weight on their own.

## Play it

The proof run produces a self-contained `index.html` in the throwaway repo — the full
tic-tac-toe game with inline HTML/CSS/JS and no external imports. Open it directly in a
browser; no build step or server needed (any static server works if your browser blocks
`file://`).
