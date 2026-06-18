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
workers, is cross-provider audited, and verifies ([`docs/research/proof-run.md`](docs/research/proof-run.md)).

## Install

pleach is a Bun CLI. It requires `git >= 2.38` at run time. The default
`umbelRunner` also needs `tmux` and the `umbel` binary on your PATH — but the runner is
pluggable (see [Adapters](#adapters)).

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

**Opting into tend.** Pass `--tend-module <path-to-tend-ingester>` to replace `gitLedger` with the
tend ledger. tend then owns verdict verification and the feature's close state. `--umbel-bin` (or
`$PLEACH_UMBEL_BIN`) selects the umbel binary when using the default runner.

Full adapter contracts, the `RunnerSeam` and `LedgerSeam` interfaces, and a guide for writing your
own: [`docs/adapters.md`](docs/adapters.md).

## Usage

```
pleach run <plan.json> [flags]     Execute a plan
pleach validate <plan.json>        Parse + validate a plan; print the topo order
pleach schema                      Emit the plan contract as JSON Schema (for planners / codegen)
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full runtime substrate and flag reference.

Doctrine: [`ENGINEERING.md`](ENGINEERING.md) · Plan contract: [`docs/contract/plan-schema.md`](docs/contract/plan-schema.md).

## Support

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://buymeacoffee.com/jahala)

MIT licensed ([`LICENSE`](LICENSE)). Part of the plot-plot suite alongside [tend](https://github.com/plot-plot) and umbel.
