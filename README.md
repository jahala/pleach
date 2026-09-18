# pleach

[![CI](https://github.com/jahala/pleach/actions/workflows/ci.yml/badge.svg)](https://github.com/jahala/pleach/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Standalone deterministic conductor for DAGs of verified agent work.** pleach takes a plan — a DAG
of nodes — isolates each node in a detached git worktree, enforces gates (conflict-marker scan,
smoke command, cross-provider audit), and publishes a `node/<id>` branch only for verified work.
The integration surface is one data contract (the plan) and two pluggable code seams (runner,
ledger). Agents produce; code decides.

> *Pleaching: the craft of training and interweaving living branches into a single structure.*

**Status — v1.** The end-to-end proof run closes: a multi-step feature builds through real agent
workers, is cross-provider audited, and verifies — and a six-feature product (a client-side PDF
unifier) has been built the same way, plan to landed code, with zero human diff-reviews. pleach's
own development is tracked in its verified garden: [`docs/tend2/garden.tend2.html`](docs/tend2/garden.tend2.html)
(self-contained pages — open any of them in a browser).

> **New to the plotplot tools?** pleach is *day 2* — reach for it when work runs unattended,
> in parallel, or must be trusted later. Day 1 is a single verifier loop
> (tend2's quickstart, linked here when it publishes); a two-line edit you review
> yourself needs neither. The full when-to-use ladder: [`docs/journal.md`](docs/journal.md)'s
> companion in the joint doc, and each tool's skill carries its own "not for" list.

## Install

pleach is a Bun CLI. It requires `git >= 2.38` at run time. The default
`umbelRunner` also needs `tmux` and an `umbel` binary that knows `--unattended`
(workers spawn promptless by default; an older umbel refuses the spawn loudly) — but the
runner is pluggable (see [Adapters](#adapters)): `pleach run plan.json --runner direct-cli`
needs only the `claude` and `codex` CLIs, no umbel, no tmux.

Run it without cloning:

```sh
bunx github:jahala/pleach validate plan.json
bunx github:jahala/pleach run plan.json
```

Or clone and link a `pleach` command:

```sh
git clone https://github.com/jahala/pleach && cd pleach
bun install && bun link    # puts `pleach` on your PATH
bun run check              # tsc + biome + tests
pleach run plan.json
```

```
faces/     cli                                  ← argv, exit codes
loop/      run-plan · run-node · run-work       ← the deterministic loop
adapters/  umbel · tend · git                   ← pluggable tool bridges (runner/ledger)
seams/     isolate · exec · lock · journal      ← pleach's own I/O
core/      plan · validate · classify · errors  ← pure
```

## Adapters

pleach needs two seams to run: a **runner** (spawns and drives an agent per node) and a **ledger**
(tracks which nodes are verified). The bundled adapters cover the most common configurations; you
can replace either with your own implementation of `RunnerSeam` or `LedgerSeam`.

**Zero-config.** With no `pleach.config.ts` and no `--config` flag, pleach defaults to
`umbelRunner` + `gitLedger`. `gitLedger` is entirely local — it reads `node/*` branches from the
git repo, no external ledger required. `pleach run plan.json` works standalone.

**Selecting adapters explicitly.** Drop a `pleach.config.ts` at the repo root:

```ts
import { umbelRunner } from 'pleach/adapters/umbel';
import { gitLedger } from 'pleach/adapters/git';
import type { PleachConfig } from 'pleach/config';

export default {
  runner: umbelRunner({ bin: 'umbel', permissionMode: 'bypassPermissions' }),
  ledger: gitLedger({ repo: '.' }),
} satisfies PleachConfig;
```

Swap either line for your own adapter without touching the plan or any other config.

> **Note:** upstream tend v1 is sunset (tend2 ships without it); this lane serves frozen v1 estates.

**Opting into tend.** Pass `--tend-module <path-to-tend-ingester>` to replace `gitLedger` with the
tend ledger. tend then owns verdict verification and the feature's close state. `--umbel-bin` (or
`$PLEACH_UMBEL_BIN`) selects the umbel binary when using the default runner.

Full adapter contracts, the `RunnerSeam` and `LedgerSeam` interfaces, and a guide for writing your
own: [`docs/adapters.md`](docs/adapters.md).

## Usage

```
pleach run <plan.json> [flags]     Execute a plan (--land to land a fully-verified close)
pleach land <plan.json> [flags]    Merge a verified plan's sinks onto the checked-out branch
pleach audit <plan.json> <node>    Re-run only the audit on a quarantined node whose build
                                   was green — a bad relay costs one auditor turn, not the node
pleach stop <plan.json> [flags]    Drain a running plan: nothing new launches, in-flight nodes
                                   settle (--now aborts them instead)
pleach validate <plan.json>        Parse + validate a plan; print the topo order
pleach schema                      Emit the plan contract as JSON Schema (for planners / codegen)
pleach receipt <node> [flags]      Verify a settled node's close receipt
pleach clean [flags]               Sweep a killed run's leavings: stale locks + orphaned worktrees
```

Landing is deterministic and fail-closed: it refuses unless **every** plan node is
verified (with `--sinks`, unless every named one is), builds the merges in a throwaway
worktree, and touches your checkout only via a final fast-forward — a conflict aborts
with the repo untouched. It holds a lock of its own beside the run's, so it never queues
behind gates it has no stake in: settled work lands while the run is still building the
rest, two landings serialise, and a refusal names the pid that holds the lock and which
of the two locks it is.

**Land a subset, and land it behind your own check.** `--sinks a,b` makes those verified
node ids the landing's sinks instead of the plan's own; a node named there that is not
verified refuses the landing by name before anything is built, and the composition gate
and the publish then cover exactly that subset. `--land-gate CMD` (repeatable, run in
order) runs on the composed stack after the sinks' smokes and before the publish,
argv-style with no shell. `{base}` is replaced by the target branch's tip as it stood
before the merges, so the gate can ask what this landing changes — which is what makes a
map's staleness check runnable at the one moment it matters. This repo's own garden lands
behind tend2's gate:

```sh
pleach land plan.json \
  --land-gate "tend2 gate docs/tend2 --base {base} --runner 'bun test {evidence}'"
```

A non-zero exit refuses the landing as `land-gate-refused` with the command's output tail
on stderr and the repository untouched, so a landing that would leave a stamped claim
unproven is refused instead of landed green. Both flags shape `pleach run --land` too — the
landing a run performs is the same landing.

**An auditor's bad relay never costs the node.** When the auditor's reply carries no readable
result — or the auditor dies — the node is quarantined with its build's gates green, and
`pleach audit plan.json <node>` re-adjudicates it: the quarantined tree is checked out again with
its dependencies merged as a run merges them, setup provisions it, and only the audit runs. A pass
publishes `node/<id>`; anything else writes a new quarantine receipt, and the receipt of every close
before it is still on file. It refuses a node whose latest close is not a quarantine with a green
smoke — an audit verdict over an unproven build proves nothing.

**A provider outage is paid once.** An attempt that comes back `dead` never got a working
session at all — an outage, not a red gate — so re-running it on the same provider buys the
same outage twice. `--fallback-provider NAME` re-casts the node on another provider instead,
with the cross-provider audit's diversity rule re-checked against it. Without a usable
fallback the node settles after the one attempt with its remaining attempts unspent, and the
verdict's `detail` names why.

**A fault in the plan is refused before a worker costs anything.** pleach execs every
command string argv-style with no shell, so `pleach validate` refuses (exit 2) a plan whose
`work.command`, `work.test`, `setup` or `accept.smoke` holds a bare shell operator such as
`&&`, `|` or `>`, naming the node, the field and the escape hatch: `bash -lc '<command>'`.
`pleach run` refuses the same plan before it takes the lock.

**A gate that cannot run fails its node once.** A gate whose command never started is a
fault of the plan or the environment, never of the work: the no-shell guard's refusal is the
plan's, a command the environment cannot spawn (a missing binary, exit 127) is the
environment's. The node settles on that attempt with the verdict's `detail` naming which; no
further attempt is spent and no worker is re-prompted. A gate that ran and failed still
retries the worker with its output.

**Halting a run never loses a node's work.** `pleach stop plan.json` drains: the scheduler reads
the stop marker in the same tick as its next launch decision, so nothing further starts and the
in-flight nodes settle normally. `--now` adds the hard abort — an interrupted node settles
`aborted`, its receipt written and its worktree kept on `quarantine/<id>`, never counted as a
failure. A wedged worker never rides the attempt clock either: `--idle-ms` (default 10m) ends a
wait that has gone quiet, and the node settles blocked with its tree kept the same way.

**The next run picks that work up.** A pending node whose `quarantine/<id>` still resolves is
isolated from it — the quarantine is the checkout base, its dependencies merge onto it as they
always do — and the worker's first prompt names the sha it is resuming and what the tree holds.
Nothing about that tree is trusted: it was never gated, so the whole ladder runs over it, from the
marker scan through smoke and the cross-provider audit, and the close records `facts.base` so a
resumed close stays distinguishable from a fresh one forever. `--fresh` refuses the seed and builds
every pending node from its dependencies alone.

**A hook that refuses a verified commit fails the node and keeps its work.** The verified commit
on `node/<id>` runs your repository's hooks, because a hook is the repository's own gate. A
refused commit is a gate verdict like any other: the node settles `failed` under the `commit`
gate, with the hook's output as the output tail in the journal and hashed into the receipt. The
tree is kept on `quarantine/<id>` and the receipt is written. That quarantine is a snapshot
(`write-tree`, `commit-tree`, `update-ref`), so no hook runs on it and no hook can refuse it.

**A seam's surprise fails the node and keeps its work.** The runner's reason is read from its
output whatever its exit code, so a timeout, a provider error or an idle worker settles the way the
runner contract classifies it. Anything else a seam throws mid-node settles the node `failed` under
the gate `seam:<lane>`, with the seam's text as the output tail and the attempt counted. The tree is
kept on `quarantine/<id>` and the receipt is written. The verdict's detail names the next step:
`pleach audit plan.json <node>` when only the audit threw, otherwise a re-run, which resumes from
the quarantine.

**A lost journal is reported, and every run keeps a copy of its own lines.** The journal at
`<git-dir>/pleach/journal.jsonl` is one file, and the receipts beside it are kept per close. Right
after `run-start`, every node whose latest receipt has no `verdict` line in the journal is
journaled as `journal-gap`, so a journal that lost lines says so the next time anyone runs. Right
after `run-end`, the run's lines from its `run-start` through its `run-end` are copied to
`<git-dir>/pleach/receipts/runs/<runId>.journal.jsonl`, and the `run-end` line names that file as
`journalCopy`. The record can be rebuilt from what is kept beside the receipts.

**A worker that writes BLOCKED.md has finished, and is not asked again.** A worker that cannot
finish the plan in its tree writes `BLOCKED.md` at the tree's root: what it tried, what stopped
it, what a fix needs. pleach reads that file when the attempt ends, before any gate runs, however
the attempt ended: a stop, a command that exits non-zero, a worker left at its prompt or out of
time. Only a provider that died or a run that halted keeps its own verdict. The node settles
`blocked` at once, with the file's text as the verdict's `blockedReason` and the tree kept on
`quarantine/<id>`, `BLOCKED.md` included. There is no retry, because a retry would only ask the
worker to explain again.

Two operational facts worth knowing before your first run:

- **Claude Code workers need the repo trusted.** Trust follows the *main checkout*
  (`~/.claude.json`), not the worktree — pleach's temporary worktrees inherit it.
  An untrusted repo makes every worker hit the trust dialog.
- **Hand-landing a quarantine is outside the ledger — by design.** If you review
  `quarantine/<id>`, merge it yourself, and verify it out-of-band, no `node/<id>`
  branch exists: the map is the ledger, and the expected follow-up is re-emission
  (an emitter that drops fully-stamped work, like tend2's, makes this a no-op). A
  gates-rerunning `land --from-quarantine` verb is deliberately unbuilt until field
  use shows the manual path failing.

**Don't want to write plan.json by hand?** The repo ships a Claude Code skill,
[`pleach-plan`](.claude/skills/pleach-plan/SKILL.md): give it a goal and a repo and it
decomposes the work into a gated DAG, then proves the result with `pleach validate`
before handing it over. Working in this repo, Claude Code picks it up automatically;
from an npm install, copy it where your sessions can see it:

```sh
cp -r node_modules/pleach/.claude/skills/pleach-plan ~/.claude/skills/
```

Agents without the skill still have the full machine-readable surface: `pleach schema`
(the plan contract as JSON Schema) and `pleach --help` (verbs, flags, exit codes).

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full runtime substrate and flag reference.

Doctrine: [`ENGINEERING.md`](ENGINEERING.md) · Plan contract: [`docs/contract/plan-schema.md`](docs/contract/plan-schema.md).

## Support

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://buymeacoffee.com/jahala)

MIT licensed ([`LICENSE`](LICENSE)). Part of the plot-plot suite alongside [tend](https://github.com/plot-plot) and umbel.
