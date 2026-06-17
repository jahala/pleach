# pleach

[![CI](https://github.com/jahala/pleach/actions/workflows/ci.yml/badge.svg)](https://github.com/jahala/pleach/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Deterministic conductor for DAGs of verified agent work.** tend decides what "done" means; rctrl runs
one unit of agent work reliably; pleach is the loop between them — isolated git worktrees per node,
enforced gates (smoke, conflict-markers, cross-provider audits), typed verdicts into tend's gated
ledger, and a `node/<id>` branch published only for verified work. Agents produce; code decides.

> *Pleaching: the craft of training and interweaving living branches into a single structure.*

**Status — v1: the proof run closes end-to-end.** A multi-step feature builds through real claude
workers, is audited by a real codex auditor, and is verified by real tend, reaching a full verified
close (`docs/research/proof-run.md`, Run 3). The deterministic loop, all six seams, and both CLI faces
are implemented and pass `bun run check` (187 tests). pleach tracks its own development in a tend garden
— [`docs/tend/`](docs/tend/) — and the landing page lives at
[jahala.github.io/pleach](https://jahala.github.io/pleach/).

## Install

pleach is a Bun CLI; it is not on npm. It conducts **rctrl** (the agent-worker boundary) and **tend** (the verified ledger), so it also needs those plus `git >= 2.38` and `tmux` at run time.

Run it without cloning (once this repo is public):

```sh
bunx github:jahala/pleach validate plan.json
bunx github:jahala/pleach run plan.json --tend-module <tend-ingester> --rctrl-bin <rctrl>
```

Or clone and link a `pleach` command:

```sh
git clone https://github.com/jahala/pleach && cd pleach
bun install && bun link    # puts `pleach` on your PATH
bun run check              # tsc + biome + tests
pleach run plan.json --tend-module <tend-ingester> --rctrl-bin <rctrl>
```

`--rctrl-bin` / `--tend-module` also read `$PLEACH_RCTRL_BIN` / `$PLEACH_TEND_MODULE`; see [`CONTRIBUTING.md`](CONTRIBUTING.md) for the runtime substrate.

```
faces/   cli                                  ← argv, exit codes
loop/    run-plan · run-node · run-work       ← the deterministic loop
seams/   rctrl · tend · isolate · exec · lock · journal   ← all I/O
core/    plan · validate · classify · errors  ← pure
```

Build plan: [`docs/plan.md`](docs/plan.md) · Doctrine: [`ENGINEERING.md`](ENGINEERING.md) · Contract:
[`docs/contract/plan-schema.md`](docs/contract/plan-schema.md) · Why the design looks like this:
[`docs/ledger.md`](docs/ledger.md) · Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Support

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://buymeacoffee.com/jahala)

Not published to npm. MIT licensed ([`LICENSE`](LICENSE)). Part of the plot-plot garden suite alongside
[tend](https://github.com/plot-plot) and rctrl.
