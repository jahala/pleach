# pleach

[![CI](https://github.com/jahala/pleach/actions/workflows/ci.yml/badge.svg)](https://github.com/jahala/pleach/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A deterministic conductor for DAGs of verified agent work.** pleach takes a plan, isolates
each node in a detached git worktree merged from its dependencies' verified branches, enforces
gates, and publishes a `node/<id>` branch only for work that passed them.

Agents produce; code decides. Close, verify, quarantine and retry are deterministic code paths.
Agent output is parsed evidence, never interpreted.

> *Pleaching: the craft of training and interweaving living branches into a single structure.*

Two products have been built this way, plan to landed code, with no human reviewing diffs: a
six-feature PDF unifier, and the stem of [plotplot](https://github.com/jahala/plotplot), a
released Rust binary in another repository and another language
([its plans are public](https://github.com/jahala/plotplot/tree/master/docs/dogfood)).

## Install

A Bun CLI. Needs `git >= 2.38`. Run it without cloning:

```sh
bunx github:jahala/pleach validate plan.json
bunx github:jahala/pleach run plan.json
```

The default runner also wants `tmux` and an `umbel` binary. `--runner direct-cli` needs neither,
only the `claude` and `codex` CLIs.

## The gate ladder

Every node goes through the same fixed sequence. The agent touches only one step of it.

```
isolate → setup → work → conflict-marker scan → stage → smoke → cross-provider audit → commit
```

A conflict marker fails closed. The smoke command is the node's own declared test. The audit runs
the check command in a fresh session from a **different model vendor**, so no model grades its own
work. Only a node that clears all of it publishes a branch.

## Usage

```
pleach run <plan.json>          Execute a plan (--land to land a fully-verified close)
pleach land <plan.json>         Merge a verified plan's sinks onto the checked-out branch
pleach audit <plan.json> <node> Re-run only the audit on a quarantined node
pleach stop <plan.json>         Drain a running plan (--now aborts in-flight nodes)
pleach validate <plan.json>     Parse and validate; print the topo order
pleach schema                   Emit the plan contract as JSON Schema
pleach receipt <node>           Verify a settled node's close receipt
pleach clean                    Sweep a killed run's stale locks and orphaned worktrees
```

`pleach --help` carries every flag, default and exit code.

## What happens when things go wrong

Work is never silently lost and a verdict is never invented. A node that cannot finish keeps its
tree on `quarantine/<id>` and writes a receipt.

| Situation | What pleach does |
|---|---|
| The auditor's relay is unreadable, or it dies | Quarantines with gates green; `pleach audit` re-adjudicates without rebuilding |
| A provider is down | `--fallback-provider` re-casts on another vendor; an outage is never paid twice |
| The plan holds a bare shell operator | Refused at `validate`, before a worker costs anything |
| A gate command cannot start | Node settles once; no attempt spent, no worker re-prompted |
| You halt the run | `stop` drains, `--now` aborts; both keep the tree and write receipts |
| A worker goes quiet | `--idle-ms` ends the wait; settles blocked, tree kept |
| A worker is stuck | It writes `BLOCKED.md` and is not asked again |
| A git hook refuses the commit | Gate verdict like any other; tree kept on a snapshot no hook can refuse |
| A seam throws mid-node | Settles under `seam:<lane>`; the verdict names the next step |
| The journal loses lines | Reported as `journal-gap` at the next run; each run keeps its own copy |

Full detail, one section each: [`docs/guarantees.md`](docs/guarantees.md).

## Adapters

pleach needs a **runner** (drives an agent per node) and a **ledger** (tracks which nodes are
verified). With no config it uses `umbelRunner` + `gitLedger`, and `gitLedger` reads `node/*`
branches from the repo, so a standalone run needs nothing external.

To choose explicitly, drop a `pleach.config.ts` at the repo root:

```ts
import { umbelRunner } from 'pleach/adapters/umbel';
import { gitLedger } from 'pleach/adapters/git';
import type { PleachConfig } from 'pleach/config';

export default {
  runner: umbelRunner({ bin: 'umbel', permissionMode: 'bypassPermissions' }),
  ledger: gitLedger({ repo: '.' }),
} satisfies PleachConfig;
```

Swap either line for your own implementation of `RunnerSeam` or `LedgerSeam` without touching the
plan. Five adapters ship; `--tend-module` opts into the tend ledger instead.
Contracts and a guide for writing your own: [`docs/adapters.md`](docs/adapters.md).

## Writing a plan

The repo ships a Claude Code skill, [`pleach-plan`](.claude/skills/pleach-plan/SKILL.md): give it
a goal and a repo and it decomposes the work into a gated DAG, then proves the result with
`pleach validate`. Agents without it still have `pleach schema` and `pleach --help`.

## Reading on

[`ENGINEERING.md`](ENGINEERING.md) is the binding doctrine.
[`docs/contract/plan-schema.md`](docs/contract/plan-schema.md) is the plan contract, and this repo
is its home. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers the runtime substrate and how to run the
tests.

pleach's own development is tracked in its verified garden:
[`docs/tend2/pleach.tend2.html`](docs/tend2/pleach.tend2.html). The pages are self-contained;
open any of them in a browser.

## Support

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://buymeacoffee.com/jahala)

MIT licensed ([`LICENSE`](LICENSE)). A bed in the [plotplot](https://github.com/jahala/plotplot)
garden, alongside [tilth](https://github.com/jahala/tilth) (code intelligence),
[weeder](https://github.com/jahala/weeder) (the judge of the diff),
[umbel](https://github.com/jahala/umbel) (fans out agent CLIs in tmux),
[pollen](https://github.com/jahala/pollen) (agent-to-agent messaging) and
[copeca](https://github.com/jahala/copeca) (cost per correct answer). tend2 and petals are built
but not public yet.
