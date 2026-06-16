# pleach

**Deterministic conductor for DAGs of verified agent work.** tend decides what "done" means; rctrl runs
one unit of agent work reliably; pleach is the loop between them — isolated git worktrees per node,
enforced gates (smoke, conflict-markers, cross-provider audits), typed verdicts into tend's gated
ledger, and a `node/<id>` branch published only for verified work. Agents produce; code decides.

> *Pleaching: the craft of training and interweaving living branches into a single structure.*

**Status — v1: the proof run closes end-to-end.** A multi-step feature builds through real claude
workers, is audited by a real codex auditor, and is verified by real tend, reaching a full verified
close (`docs/research/proof-run.md`, Run 3). The deterministic loop, all six seams, and both CLI faces
are implemented and pass `bun run check` (187 tests). pleach now tracks its own development in a tend
garden — [`docs/tend/`](docs/tend/) (dashboard: [`index.html`](index.html)).

Build plan: [`docs/plan.md`](docs/plan.md) · Doctrine: [`ENGINEERING.md`](ENGINEERING.md) · Contract:
[`docs/contract/plan-schema.md`](docs/contract/plan-schema.md) · Why the design looks like this:
[`docs/ledger.md`](docs/ledger.md).

```
faces/   cli                                  ← argv, exit codes
loop/    run-plan · run-node · run-work       ← the deterministic loop
seams/   rctrl · tend · isolate · exec · lock · journal   ← all I/O
core/    plan · validate · classify · errors  ← pure
```

Not published to npm. Part of the plot-plot garden suite alongside [tend](https://github.com/plot-plot)
and rctrl.
