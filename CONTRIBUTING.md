# Contributing to pleach

Thanks for your interest. pleach is the deterministic conductor for DAGs of verified agent work — see [`README.md`](README.md) for what it is, and **read [`ENGINEERING.md`](ENGINEERING.md) before any substantial change** — it is the binding engineering doctrine, not optional reading.

## Setup

pleach runs on [Bun](https://bun.sh).

```sh
bun install
bun run check   # tsc --noEmit + biome + bun test — must be green before any PR
```

## The non-negotiables

Enforced in review (and most by CI). Full detail in `ENGINEERING.md`:

- **Test-first.** No fix or feature without a failing test first. Every defect maps to an item in [`docs/ledger.md`](docs/ledger.md) and lands as a RED test before its fix.
- **No stubs, mocks, or TODOs in committed code.** The in-memory seams in loop tests are real implementations of the seam interfaces, not behaviour-mocks.
- **S.U.P.E.R., strict downward deps.** `core/` is pure and total and imports nothing else; `seams/` and `faces/` own all I/O; `loop/` composes injected seams it never imports. A face never calls git; the loop never spawns a process; a seam never makes a scheduling decision.
- **Typed errors, caught at the face.** Discriminated `Error` subclasses live in `core/errors.ts`; faces map them to exit codes.
- **Single schema source.** `core/plan.ts` is pinned byte-for-byte to `docs/contract/plan-schema.md` by a drift test. A schema change = doc + source + drift-test + `docs/contract/CHANGES.md` in one commit.
- **Smallest reasonable change**, matching surrounding style.

## Running the tests

`bun test` runs everything. The `core/` unit tests and the in-memory `loop/` tests run anywhere. The **integration** and **e2e** suites need the runtime substrate and skip cleanly unless you point them at it:

| Env var | What |
|---|---|
| `PLEACH_RCTRL_BIN` | path to the `rctrl` binary |
| `PLEACH_TEND_MODULE` | path to a tend ingester module |

They also need `git >= 2.38` and `tmux` on PATH. With the vars unset those suites skip — which is exactly how CI runs.

## Pull requests

1. Branch from `master`.
2. Make the change test-first; keep `bun run check` green.
3. Fill the PR template checklist; commit messages follow `type(scope): subject`.
4. Be kind — see [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
