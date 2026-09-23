# Contributing to pleach

Thanks for your interest. pleach is the deterministic conductor for DAGs of verified agent work; see [`README.md`](README.md) for what it is, and **read [`ENGINEERING.md`](ENGINEERING.md) before any substantial change.** It is the binding engineering doctrine, not optional reading.

## Setup

pleach runs on [Bun](https://bun.sh).

```sh
bun install
bun run check   # tsc --noEmit + biome + bun test; must be green before any PR
```

## The non-negotiables

Enforced in review (and most by CI). Full detail in `ENGINEERING.md`:

- **Test-first.** No fix or feature without a failing test first. Every defect maps to an item in [`docs/ledger.md`](docs/ledger.md) and lands as a RED test before its fix.
- **No stubs, mocks, or TODOs in committed code.** The in-memory seams in loop tests are real implementations of the seam interfaces, not behaviour-mocks.
- **S.U.P.E.R., strict downward deps.** `core/` is pure and total and imports nothing else; `seams/` and `adapters/` own all I/O; `loop/` composes the injected seams + adapters it never imports; `faces/` wires them. A face never calls git; the loop never spawns a process; a seam never makes a scheduling decision.
- **Typed errors, caught at the face.** Discriminated `Error` subclasses live in `core/errors.ts`; faces map them to exit codes.
- **Single schema source.** `core/plan.ts` is pinned byte-for-byte to `docs/contract/plan-schema.md` by a drift test. A schema change = doc + source + drift-test + `docs/contract/CHANGES.md` in one commit.
- **Smallest reasonable change**, matching surrounding style.

## Running the tests

`bun test` runs everything. The `core/` unit tests and the in-memory `loop/` tests run anywhere. The **integration** and **e2e** suites need the runtime substrate and skip cleanly unless you point them at it:

| Env var | What |
|---|---|
| `PLEACH_UMBEL_BIN` | path to the `umbel` binary |
| `PLEACH_TEND_MODULE` | path to a tend ingester module |
| `PLEACH_CANARY_TEND2` | how `scripts/canary.sh` invokes tend2 (e.g. `node /path/to/dist/cli.js`); defaults to `tend2` on PATH |

They also need `git >= 2.38` and `tmux` on PATH. With the vars unset most of those suites skip.

`test/integration/umbel-abort.test.ts` and `test/integration/umbel-idle.test.ts` fall back to whatever `umbel` is on PATH, so they run for anyone who has the binary installed, even with `PLEACH_UMBEL_BIN` unset.

CI runs the suites that need only umbel in two places. The `runner` job in `ci.yml` builds umbel at the commit pinned in `UMBEL_REF` and runs them on every push and pull request. The weekly `umbel-head` job in `canary.yml` runs them against umbel's default branch, so a move in umbel's `wait` or `kill` contract shows within a week. Bump `UMBEL_REF` once `umbel-head` is green on the new commit. The suites that also need a tend module still run only locally.

## Pull requests

1. Branch from `master`.
2. Make the change test-first; keep `bun run check` green.
3. Fill the PR template checklist; commit messages follow `type(scope): subject`.
4. Be kind; see [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Issues are an inbox

pleach does not accumulate issues, it converts them. Every triaged issue
becomes exactly one of:

1. **A failing check.** A bug is a RED test that can only be closed by going
   green, never by prose. The issue closes with a pointer to the test.
2. **A decision record.** A "why is it like this?" gets its answer written
   down (context, options, rejection reasons) where the next reader will look.
3. **A recorded no.** Declined, with the reason, kindly.

The `untriaged` label marks the queue; templates collect exactly what
conversion needs. Status lives in checks and branches: computed, never
asserted, so an open issue is always "not yet triaged," never "known broken."

## Brand checks are local

`.brand/` is committed (see `.petalsrc`): pleach's own product layer under
`.brand/products/pleach/`, plus the plotplot umbrella cached from the public
[plotplot](https://github.com/jahala/plotplot) repo at the tag `.petalsrc` pins. CI has no
petals tooling, so it cannot brand-check either way.
Landing-page and copy changes are checked locally with the petals skill (`/petals check index.html`)
before committing. The page's "passes /petals check" badge is a maintainer promise, not a CI gate.

## Why this is not on npm

`package.json` carries `"private": true`, deliberately. The `pleach` bin is
`src/main.ts` under a `#!/usr/bin/env bun` shebang and there is no build step, so
an npm package would install cleanly and then fail for anyone without Bun:
`npx pleach` would die on `env: bun: No such file or directory`. Publishing a
package that breaks the command people will actually type is worse than not
publishing one.

Installing from GitHub works today and needs no registry:

```sh
bunx github:jahala/pleach validate plan.json
```

What would change the decision is a build step that emits something Node can run,
at which point `"private"` comes off and the name is free to claim. Until then the
flag is also a guard against publishing by accident.
