# Dogfood — seam-keeps-tree (D23, jahala/pleach#120, #110)

What the pleach agent hit in tend2, pleach, umbel, weeder and pollen while shaping and conducting
this loop. Conducted with the pinned pleach (411a1eb) and the pinned tend2 (e270dd9), both by path,
claude-opus-5 workers through the installed umbel (rebuilt 2026-09-18), `weeder check --strict` as
smoke, the pinned tend2 verifier as a self-integral audit run by codex, every run under `caffeinate`.

## Shaping (2026-09-18)

- **The conductor that builds the fix carries the defect.** The pin is master, and master loses the
  tree of any node whose wait ends other than `stop`. A timeout, an idle, a sleep or a stalled
  auditor during this loop costs that node's attempt and its tree; `caffeinate` removes the sleep,
  nothing removes the rest. Known going in; a lost node is re-run.
- **The umbrella's seam test reads pleach by regex** (`contracts/test/runner.test.sh`: the first
  `reason?: …;` in `src/loop/deps.ts`, and `case`/`return` lines inside `classifyWorkerReason`). The
  work order tells the workers to keep those shapes, and the contract check applies the same regexes
  so a refactor breaks pleach's own suite before it breaks the seam.
- **bun has no offline install.** `bun install --frozen-lockfile` is served from the global cache
  when the lockfile is unchanged; there is no flag to forbid the network the way `cargo --offline` does.
- **The sink is a proof node from the start** (#104): its behaviours are its siblings', so it runs one
  green phase. The generator in this repository gained the shape umbel's copy had.
- **`tend2 emit-plan` still reports `unwired-modules` preflights for six landed loops** on every
  emit; the payload pin is read from its output regardless.
- **Master's check is red on this machine before the loop starts** (jahala/pleach#121). The installed
  umbel was rebuilt today; three of pleach's integration tests over the real binary now fail on #120
  itself, and a fourth reads `umbel status`'s exit code as liveness, which umbel#73's tombstones broke
  (a killed session exits 0 with STATUS dead). CI never saw it: those suites skip without the binary.
  Both ride the first node, since no node's GREEN gate can pass until they are green.
- **The two red tests were written by hand while the seat was held** (the umbrella's word: they need
  no seat), proven red against master for the right reason, and committed as drafts under
  `docs/dogfood/seam-keeps-tree/red/` — at their evidence paths they would make every node's base red.
  Each node's RED phase copies its draft into place. Both cite the runner seam's section "A non-zero
  exit with a reason is a result".
- **An hour on every node's clock, and fresh relaunches** (the umbrella's caution from quadrat's
  night): until this loop's own fix lands, the conductor drops a tree on any non-stop wait, so the
  attempt clock is the one loss that can be pushed away. A lost node is relaunched with `--fresh`
  rather than resumed: a resumed tree carried a stale plan and block note on quadrat (being filed there).

## Conducting (2026-09-18)

- **Two conductors, one `umbel ls`, no way to tell their workers apart by name.** pleach names every
  worker `pl-<8 hex>` with no prefix option, and `umbel ls` truncates the CWD to the same
  `…pleach/worktrees/wt-…/wt` for both repositories; mine is told from quadrat's only by its
  creation time and `meta.json`'s cwd. jahala/umbel#65 (ls shows each session's repository and
  conductor) covers umbel's side; a `--worker-prefix` on pleach would cover the conductor's.
- **codex probed through the rebuilt umbel before dispatch:** spawn, one prompt, `stop` in six
  seconds, the reply read back intact (codex-cli 0.154.0, model gpt-5.6-sol).
- **Node one built green in fourteen minutes and settled blocked on the verifier** (jahala/tend#224).
  tend2 master e270dd9 refuses any green run whose test count it cannot read — the fix for tend#207,
  which this agent filed — and its readers are vitest, cargo, pytest, go and TAP: no bun. With the
  runner `bun test {evidence}` every check of every bun garden is refused whatever the code does;
  reproduced on a scratch page with a two-test green suite. bun 1.3.14 has no TAP reporter. The worker
  wrote BLOCKED.md rather than shape its test's output to please the verifier. Not worked around: no
  TAP shim, no `--allow-empty`, no older verifier pin. The tree is quarantined with a receipt; the node
  is relaunched `--fresh` once the verifier can count bun.
- **The drafted red test needed no change**: the worker copied it into place and the RED gate sealed
  in two minutes. The four red master tests (pleach#121) went green inside the same node; the abort
  helper now reads `umbel status <name> --json`'s `alive`.
- **The umbrella ruled: land the reader on tend myself, through the tools** (tend2's agent was not
  up; I held the reproduction). One loop, one node on a clone of jahala/tend under my own pins:
  page `docs/tend2/bun-reader.tend2.html`, shaped from bun 1.3.14's captured output. tend's own
  `emit-plan` wrote the plan this time (`--only`, `--cast-file`, `--audit-file`, `--setup`,
  `--node-timeout-ms`): one phased node whose phase gate, smoke and audit are all the pinned verifier,
  the audit self-integral and run by codex. tend's suite is vitest, which the pinned verifier reads,
  so the node that teaches the verifier bun can itself be verified.
- **The tend node closed in one attempt in under four minutes**, red first, the codex audit relaying
  `tests: 19`. The reader hears bun only where a `Ran N tests across M files.` line stands under
  entries naming both pass and fail; six fixtures are real captures with their commands in the
  corpus README. Proven on real suites with the built verifier: a green bun suite stamps with
  `tests: 2`, a fully skipped one is refused.
- **Two faults in tend's suite met on the way to landing.** `test/next-status.test.ts` dated its
  fresh work 2026-08-18 against a 30-day window and went red on master on 2026-09-17, blocking
  every landing through `scripts/land.sh` (jahala/tend#225; fixed by hand as a recorded hotfix, the
  case the umbrella's ruling allows). The vendored plan schema has drifted from pleach master by
  one line — `wait` gained `idleMs` in pleach's teardown loop on 2026-09-11 and nobody re-vendored —
  and tend's drift test reads the canonical text from this agent's `cayenne` workspace on whatever
  branch it holds (jahala/tend#226; CI skips that layer, so it does not block). pleach's half of the
  lesson: a change to the contract doc's adapter section is a re-vendor event and was not announced.
- **tend landed at dbd7e44** (jahala/tend#227, merged on green by tend's own `scripts/land.sh`, #224
  and #225 closed by it). The verifier pin moved to it, the page's payload pin did not move, and
  node one was relaunched `--fresh`.
- **Whose pins are whose.** The umbrella's clones live at `/tmp/pleach-pinned` and `/tmp/tend2-pinned`;
  its order had called them mine, and I pulled and rebuilt its tend2 clone to dbd7e44 before its
  correction arrived (told, in full). This agent's pins now live under `/tmp/pleach-agent/` (tend
  built with `bun install --frozen-lockfile` and `bun run build`, pleach at master), the plan's audit
  command names that verifier, and the run leaning on the umbrella's clones was drained with
  `pleach stop --now` three minutes in — aborted cleanly, nothing lost. A pin's path says nothing
  about its owner; a `PINNED_BY` file beside each clone would.
- **pollen: a message that lands while no watcher is armed rings nothing later.** In this session the
  harness gives a background watch thirty minutes of life, and two of the umbrella's messages — a
  ruling and a correction — fell into the gaps between an expiry and the re-arm; each was read only
  at the next re-arm's inbox check, one of them after the action it forbade. The inbox kept them, so
  nothing was lost, but the channel has no "unread since" ring on connect: a watcher that starts
  with mail already waiting should say so at once.
- **The umbrella's own seam test goes green on node three.** `contracts/test/runner.test.sh`, run by
  hand against `node/sk.contract`'s source and umbel master: every reason named, every class as the
  fixture says, exit 0 — it was red on provider-error, file and pattern (contracts c13). Telling the
  workers which regexes read their code kept the refactor inside the shapes the seam reads.

### The run, in numbers (2026-09-18)

Run: `caffeinate -i bun /tmp/pleach-agent/pleach/src/main.ts run docs/dogfood/seam-keeps-tree/plan.json --repo-root . --max-concurrency 1`,
three times: run 1 built node one green and settled it blocked on the verifier (tend#224); run 2,
relaunched `--fresh` after the bun reader landed, was drained two minutes in to move off the
umbrella's clones; run 3, `--fresh` on this agent's own pins, closed all five. Workers
claude-opus-5 through the installed umbel (rebuilt 2026-09-18), smoke `weeder check --strict`,
audit = the pinned tend2 (dbd7e44) verifying the node's check as a self-integral audit run by
codex, every run under `caffeinate`, an hour on each node's clock. Result: 5 of 5 nodes verified in
5 attempts on the working verifier (7 counting the blocked and the drained one); landed by
`pleach land` (land gate green) onto fix/seam-keeps-tree at ddc39e8; `bun run check` green against
the real umbel — 803 pass, from 759 pass and 4 fail on master; every check stamped by the pinned
tend2 with its count beside it. No wait ended other than `stop` in this loop, so the defect it
fixes never bit the conductor that built it.

| node | check | attempts | wall | what the extra attempt was |
|---|---|---|---|---|
| sk.reason | c1 | 1 (+1 blocked, +1 drained) | 13m10s | run 1: 13m56s, green, blocked on the verifier's missing bun reader; run 2: drained at 1m48s to change pins |
| sk.settle | c2 | 1 | 9m59s | — |
| sk.contract | c3 | 1 | 13m42s | — |
| sk.docs | c4 | 1 | 8m34s | — |
| sk.e2e | c5 | 1 | 6m05s | a proof node from the start (#104): one green phase, no block |

- **Two of five handbacks were the message before the last one** (sk.reason, sk.e2e), on the umbel
  rebuilt today: jahala/umbel#86 is still open and still bites. Their Tried lines are transcribed
  from the workers' transcripts and the page says so.
- **The drafted red tests went in unchanged** and sealed the RED gate in two to four minutes per
  node; the proof node designed as one green phase closed in six minutes where the same shape cost
  a blocked attempt and a reshape on umbel's first loop.
- **codex held the audit lane for all six audits** (five nodes and the tend node), each relaying a
  counted verdict; none stalled.
