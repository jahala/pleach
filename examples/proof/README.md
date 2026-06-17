# Proof Run — Wordcount Example

This directory is the P6 proof payload for pleach. It contains:

- `project/` — a tiny TypeScript/Bun wordcount library in honest-partial state
- `project/docs/tend/` — a real tend garden with one feature polyglot (`wordcount.tend.html`)
- `plan.json` — a hand-written v1.1.1 Plan that the conductor will execute

## Honest-partial state

The project is pre-seeded with `countWords` implemented and tested. The plan's work adds the remaining three functions:

| Node | Work | Pre-exists? |
|---|---|---|
| `wordcount.s1` | `countLines` (test-first, claude) | no |
| `wordcount.s2` | `countChars` (test-first, claude) | no |
| `wordcount` (integration) | `stats()` + merge + codex audit | no |

`countWords` must NOT be removed or broken by any worker — it's the existing foundation. This is the honest-partial constraint that re-trips the A1/A2 deadlocks if they were mis-fixed.

## How the proof harness runs it

The proof run (gated `PLEACH_PROOF=1`, once P4/P5 land) will:

1. **Copy** `examples/proof/project/` to a fresh temp directory.
2. **Initialize** a git repo in that copy (`git init && git add . && git commit`).
3. Run:
   ```
   pleach run examples/proof/plan.json
   ```
   The harness overrides `plan.source` to point at the copied project's tend polyglot.

The copy step is required because:
- tend's negctrl spins up a detached git worktree from the project's repo root.
- pleach isolates each node in its own worktree from the project's git history.
- `project/` living inside the pleach repo would make negctrl resolve paths against the pleach root.

## Tend garden

The garden has one feature polyglot: `project/docs/tend/features/wordcount.tend.html`.

The polyglot is a minimal bash+HTML artifact (constructed from the fixture pattern in
`missoula/tests/fixtures/audit-emit/passing/docs/tend/features/__fixture__.tend.html`).
It satisfies `readPolyglotOoData` (missoula's `<script id="oo-data">` extractor regex) and
supports the `data` verb for shell inspection.

### Verified tend invocation

`tend` must be on your PATH; otherwise replace it with `bun /path/to/missoula/src/bin/tend.ts`.

The following was run from the pleach repo root (project lives inside pleach's git tree,
so negctrl's git-root resolution falls back to the pleach root — the negctrl exits 2
"target file not found" but the audit still runs and emits the result fence):

```
cd examples/proof/project && tend audit wordcount
```

Output (stderr → stdout):

```
Error: target file not found: src/count.ts
audit wordcount: 2 check(s)
  c1: partial [negctrl ran=false discriminated=false]
  c2: partial
```tend-audit-result
{
  "verdicts": [
    {
      "check": "c1",
      "verdict": "partial",
      "reasons": ["negctrl could not run (invalid baseline / indeterminate); capped at partial"],
      "negctrl": { "ran": false, "discriminated": false },
      "evidencePath": "bun test test/count.test.ts → negctrl: indeterminate (exit 2)",
      "evidenceSha": "..."
    },
    {
      "check": "c2",
      "verdict": "partial",
      "reasons": ["no negctrl spec — discrimination unproven by compute audit; capped at partial"]
    }
  ],
  "drift": []
}
```

Expected behavior in the real proof run (project in its own git repo):
- c1: negctrl finds `src/count.ts`, breaks `return trimmed.split(/\s+/).length + 1`, the test flips — exits 0 (discriminates) → verdict `pass`
- c2: no negctrl spec → capped at `partial` (by design — proves tend's honest-middle works)
- Overall: `partial` (not `pass`) until codex confirms the checks are satisfied

### Garden construction method

The polyglot was constructed by **fixture-replication** (not the full tend CLI), copying the
minimal shape from:
```
missoula/tests/fixtures/audit-emit/passing/docs/tend/features/__fixture__.tend.html
```
and extending it with:
- Full six-slot content (`what`, `why`, `how`)
- Three steps with `step_type: 'agent'` and correct `dependencies`
- Two checks with `verification_recipe`s (c1 with negctrl, c2 without)

A bash dispatch wrapper was added so `bash wordcount.tend.html data | jq .` works —
the full tend BED template was NOT copied (it's 7000+ lines of shared partials that
would obscure the signal).

## Plan structure

```
wordcount.s1 ──┐
               ├──► wordcount  (integration + codex audit)
wordcount.s2 ──┘
```

- `wordcount.s1` and `wordcount.s2` run in parallel (no deps between them; conductor concurrency).
- `wordcount` waits for both, merges, implements `stats()`, runs `bun test`, then triggers the codex audit.
- The codex audit (`tend audit wordcount`) emits a `tend-audit-result` block that the conductor parses.
- Model-diversity enforced: worker provider = claude (default), audit provider = codex.

## What "success" means

The proof run succeeds when:

1. `bun test` passes inside the wordcount project after the integration step.
2. The codex audit emits `tend-audit-result` with at least one `verdict: "pass"` for c1 — meaning the negctrl discriminated (the breaking mutation causes the test to fail).
3. tend's ingester flips the wordcount feature status to `verified` (c1 pass + negctrl.discriminated).

If codex's audit emits `partial` or `fail` for c1, that surfaces a real defect. Fix it RED-first
per ENGINEERING.md §Non-negotiables.
