# Dogfood — land-honestly (D18, jahala/pleach#83 #84)

What the pleach agent hit in tend2, pleach, umbel, weeder and pollen while conducting this loop.
The shaping-pass findings that apply to every loop of the 2026-09-08 order are recorded once in
`test-phase-commit.md`; this file carries what this loop's run added.

## Conducting (2026-09-11/12)

Run: `pleach run docs/dogfood/land-honestly/plan.json --repo-root . --max-concurrency 1`, the
second agent beside tend2, workers claude-opus-5 through umbel, smoke `weeder check --strict`,
audit = tend2 verify on the node's check as a self-integral audit run by opencode +
deepseek/deepseek-v4-pro. Result: 5 of 5 nodes verified in 6 attempts; landed by `pleach land`
(fast-forward, land gate green) onto feat/land-honestly at 7f6ec3f; `bun run check` green (649
tests); every check stamped by `tend2 verify`.

Conducted under D13, D14, D16 and D17: the first loop whose Tried lines were read from pleach's own
receipts store (`<node>.handback.md`) rather than from a provider's transcript.

| node | check | attempts | wall | what the extra attempt was |
|---|---|---|---|---|
| lh.land-lock | c1 | 1 | 11m02s | — |
| lh.sinks | c2 | 1 | 11m04s | — |
| lh.land-gate | c3 | 1 | 14m46s | — |
| lh.docs | c4 | 1 | 8m54s | — |
| lh.e2e | c5 | 2 | 26m08s | the RED gate refused a proof that already passed; the retry found `run --land` dropping `--sinks` |

### Findings, per node
### lh.land-lock (verified, 1 attempt(s), audit pass)
- Handback kept by pleach itself (D17 live): Tried read from receipts/lh.land-lock.handback.md, not from a transcript.
- 11m02s. LockKind on LockHeldError ("land lock held by pid N at <path>"); acquireLand at `<lock>.land` through the one acquire ladder (O_EXCL → liveness → stale takeover); landPlan takes the land lock only; `pleach clean` sweeps `.lock.land` too and deliberately never the `.stop` marker (no pid, sweeping it would cancel an operator's drain). Reviewed.

### lh.sinks (verified, 1 attempt(s), 663s, audit pass)
- `--sinks a,b` parsed at the face; landingSinks() refuses unknown ids as PlanInvalidError before the lock; the every-node-verified scope becomes the named subset (refused by its own ids); land-start journals `sinks`; help gains "Flags (land)". Reviewed. #85's land half is covered by this node (its run half stays open).

### lh.land-gate (verified, 1 attempt(s), 885s, audit pass)
- `--land-gate CMD` repeatable; refuseUnrunnableGates() refuses a bare shell operator BEFORE the stack is built (land-gate-refused, exit -1); LandStack.baseSha captured by the seam from the target tip before the merge; `{base}` substituted; gates run after the sinks' smokes; red → land-gate-refused {command, exitCode, outputTail} + LandBlockedError, stack disposed, checkout untouched; no bisect for map gates. Reviewed.

### lh.docs (verified, 1 attempt(s), 533s, audit pass)
- journal.md: land-gate-refused row, land-start gains sinks; KINDS pinned; README + help list --sinks and --land-gate and the runbook line the garden passes. Reviewed.

### lh.e2e (verified, 2 attempts, 26m08s, whole-page audit 5/5 pass)
- Attempt 1 was refused by the RED gate (the first proof already passed against the landed siblings). The retry's honest red: `pleach run --land` built its landing options separately from `pleach land` and dropped `--sinks`, landing the whole plan at exit 0. One `landOpts(flags)` builder now serves both. Sixth time this week the gate that says "a test must fail first" turned an already-green test into a real defect.
- Four real-CLI scenarios: a fixture gate reading `{base}` refuses a stale landing and lands once green; tend2's own gate refuses a landing that moves a stamped evidence file (skipped honestly where the binary is absent); `--sinks` lands one verified node while another process holds the run lock; `run --land --sinks` lands the named sink only.

### Tools, this run
- tend2: `tend2 gate --help` RAN the gate on this repository instead of printing help (tend#165, commented) — a `--help` that runs is worse than one that prints the global usage.
- pleach: the receipts directory now holds `.handback.md` per close; from this loop on the transcription step reads it instead of `~/.claude/projects`. `pleach clean` sweeps `.lock.land` and never the `.stop` marker.
- umbel, weeder, pollen: nothing new. `weeder check --strict` green on all five.

### Issues touched from this loop
- pleach #83, #84 — closed with the merge commit. #85's land half (`--sinks`) is covered here; its run half stays open.

## Tried lines from the workers' handbacks (the last phase's, verbatim)

One line per node is transcribed onto the page, marked as transcribed from the handback pleach kept
beside the receipt. The kept files are the record; these are copies.

#### lh.land-lock (c1)
- (handback, kept by pleach at receipts/lh.land-lock.handback.md) Tried: 2026-09-10 GREEN phase — ran `bun run check` (0 red: 615 pass, typecheck and biome clean), re-ran the check's evidence standalone and the three neighbouring lock tests, and ran `weeder check --strict` myself (exit 0, no findings); made no further edits because nothing was red, so the c1 implementation is unchanged from the implement phase; next worker: `--sinks` and `--land-gate` land in `parseFlags`/`verbLand`, and `land-start` still journals only `{goal}`.

#### lh.sinks (c2)
- (handback, kept by pleach at receipts/lh.sinks.handback.md) Tried: 2026-09-10 ran `bun run check` green (622 pass, 0 fail, biome and tsc clean) over the `--sinks` implementation — `LandOpts.sinks`, `landingSinks()` refusing unknown ids as `PlanInvalidError` before the lock, a verification scope so a named subset is refused by only its own ids, `land-start {sinks}`, and the CLI flag on `verbLand` with help text; rejected passing the flag into the `run --land` path (that landing follows a fully-verified close, so a subset there is a separate feature) and rejected moving `landingSinks` into core/validate.ts (landing policy, not plan structure); next worker: the named ids become the sinks outright so an interior node is a legal target, and `--land-gate` runs in the same provisioned stack after the subset's smokes.

#### lh.land-gate (c3)
- (handback, kept by pleach at receipts/lh.land-gate.handback.md) Tried: 2026-09-10 green phase — ran `bun run check` (0 red; typecheck, biome and all 639 tests clean) and `weeder check --strict` (exit 0, no findings) against the `--land-gate` implementation from the previous phase; nothing needed fixing, so I changed no files rather than manufacturing edits; next worker: README still lists neither `--sinks` nor `--land-gate`.

#### lh.docs (c4)
- (handback, kept by pleach at receipts/lh.docs.handback.md) Tried: 2026-09-10 c4 GREEN confirmed — `bun run check` exits 0 with nothing to fix; the diff is README.md alone (landing paragraph: `--sinks`, `--land-gate`, `{base}`, the `land-gate-refused` outcome, the landing's own lock, and the `tend2 gate docs/tend2 --base {base} --runner 'bun test {evidence}'` runbook block, verified runnable through core/argv.ts's real toArgv/shellOperatorTokens). Rejected touching src/faces/cli.ts and docs/journal.md — the sibling nodes had already landed the help block, the journal rows and the KINDS entry, so the README was the only honest gap. Next worker: c5's e2e is the only check left open.

#### lh.e2e (c5)
- (handback, kept by pleach at receipts/lh.e2e.handback.md) Tried: 2026-09-10 green — `bun run check` exits 0 (638 pass, 11 skip, 0 fail; biome clean on the new e2e and fixture); the only production change is `src/faces/cli.ts` giving `pleach land` and `run --land` a single `landOpts(flags)` builder, since `run --land` had been dropping `--sinks` and landing the whole plan at exit 0, plus the README and `--land` help saying both landing flags apply there; rejected patching the one missing field at the call site (two option literals are the defect's class) and rejected refusing the `run --land --sinks` combination as a usage error (narrowing which verified sinks reach the branch is exactly what the flag means); the tend2 case runs here and skips only where the binary is absent, and real `tend2 gate --base` stays rename-blind so the fixture gate's `--no-renames` carries the moved-evidence case — and never run `tend2 gate --help` in this checkout, it runs the gate and voids stamps.
