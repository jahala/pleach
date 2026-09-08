# Dogfood — test-phase-commit (D13, jahala/pleach#62)

What the pleach agent hit in tend2, pleach, umbel, weeder and pollen while shaping and conducting
this loop. One entry per observation: tool, severity, what happened, what was expected, what was
done. Findings from the shaping pass apply to all three loops of the 2026-09-08 order and are
recorded here once; the sibling files (`gate-artifacts.md`, `journal-envelope.md`) carry only what
their own runs added.

## Shaping (2026-09-08, before any worker ran)

### pollen

1. **Watcher rings one knock hundreds of times, and re-announces every read message forever** ·
   moderate · `pollen.mjs --watch pleach` printed "cape-town is knocking" ~300 times for one held
   peer, then rang all ten historical messages on every tick. Root cause (from the journal on disk):
   two processes append to one journal with independent `seq` counters (the receiver's `delivered`
   series and the gate's `pending` series interleave; three lines duplicated outright), so "entry N
   is line N" fails, the watcher's resync resets to 0 each tick and replays. → jahala/pollen#19
   (with the root cause as a comment). Workaround: `tail -F` the journal file.
2. **The gate is invisible from the MCP side** · moderate · startup said "5 knocks waiting" without
   names; `pollen_inbox` said "No new messages" while five messages were held. Only the watcher's
   stderr named the peer. → jahala/pollen#19.
3. **A byte-identical message arrived twice**; lines carry no message id and no sent-at, so the
   receiver can neither dedupe nor order them. → jahala/pollen#19.
4. **`--watch <id>` still needs `POLLEN_ID` in the environment**; the server's instruction string
   omits that. `POLLEN_ALLOW` is a list only — "allow anyone who knocks" (the owner's rule for the
   night) has no expression. → jahala/pollen#19.

### tend / tend2

5. **The v1 `tend` MCP entry pointed at a deleted file** (`…/missoula/dist/bin/tend.js serve`) →
   every `tend_*` tool was CONNECTION_CLOSED for the session. Repointed `.mcp.json` to `tend2 mcp`
   (machine-local, gitignored); CLAUDE.md now says so. Nothing in the repo notices a dead MCP binary.
6. **pleach's own CLAUDE.md still described tend v1** (bash-polyglot reads, `tend_get_unblocked`) —
   a worker in a conducted worktree reads that file. Rewritten for tend2 in this branch.
7. **emit-plan emits one node per loop** (known: jahala/tend#158) and **its verify command defaults
   to `<cwd>/dist/cli.js`** (known: jahala/tend#157). Worked around: `--verify-bin
   /opt/homebrew/bin/tend2` and the hand-split generator `docs/dogfood/make-plan.ts`.
8. **emit-plan cannot emit a phased `{test, phases}` node** — the test-first mandate is a sentence in
   the prompt, so the separate red-phase commit this loop builds never triggers on an emitted plan.
   → jahala/tend#163.
9. **emit-plan without `--runner` emits a verify gate that cannot pass** on `.test.ts` evidence (the
   default runner executes the file directly). → jahala/tend#160 (filed by cape-town from this
   report). `--runner "bun test {evidence}"` is required.
10. **The payload pin treats a `## Tried` line as payload**: a worker appending the Tried line the
    garden law requires trips `--expect-payload` ("payload drift, SNAG-13"). → jahala/tend#159 (filed
    by cape-town). Interim: every node's handback ends with a `Tried:` line the conductor transcribes,
    marked as transcribed.
11. **`verify --check 1 --check 2` silently keeps only the last flag.** → jahala/tend#164.
12. **`tend2 <verb> --help` prints the global usage**, not the verb's flags. → jahala/tend#165.
13. **emit-plan on this garden yields 29 preflight warnings**: 25× `missing-evidence-path` for checks
    whose evidence sits inside a parenthesis ("(inferred from test/…)") after the v1 migration, 4×
    `unwired-modules`. It says those checks "can never be verified" while `tend2 next` reports 48
    fresh stamps; and it emitted 3 nodes for 19 loops without saying why 16 were skipped. Not filed:
    the garden's own migration debt, to be cleaned when those loops are next touched.
14. **The work order promises `.loop-scratch/` is "never collected"**, but under pleach the
    conductor collects (stages every untracked-unignored path) and knows no such convention.
    Interim: `.loop-scratch/` ignored in this repo; the gate-artifacts loop makes pleach refuse it
    as delivery by rule.
15. **A `verify` run with a fresh stamp reports `skipped-fresh` and still emits a `pass` verdict in
    the audit egress** — honest given content-keyed stamps, but a conductor's audit that never
    re-ran the evidence reads the same as one that did. Worth a distinct verdict word.

### umbel

16. **`umbel spawn --help` prints the global usage.** → jahala/umbel#66.

### pleach

17. **`biome.json` included both gardens** — a bare `biome check --write .` (some earlier session)
    rewrote all nineteen v1 polyglots and tend2's renderer; 22 uncommitted files on arrival, left
    untouched (not this session's work). Fixed in this branch: the gardens are excluded.
18. **D12 (teardown, PR #58) was cited by code and docs/journal.md but never written into
    docs/ledger.md.** Added from the commit's own account.
19. **Retrying a phased node on the same tree was already broken**: once impl exists in the tree the
    RED gate ("must fail") cannot pass again, so every retry of a `{test, phases}` node after a green
    or smoke failure burned an attempt. Found while designing the seal; the loop's retry check
    (resume at impl once sealed) closes it.
20. **The exec seam interleaves stdout and stderr into one `output`** — a gate whose stdout is a
    document (SARIF) cannot be recovered from it. Becomes the first check of gate-artifacts.

### umbrella (jahala/plotplot)

21. **pleach's fit loop cites `scripts/fit/pleach.sh`, which does not exist** at a107c14 — cape-town
    confirms the per-bed fit scripts are the umbrella's next conducted work; the fit checks stay open
    honestly.
22. **The profile pinned one kind for pleach** (`gate.retry`) and forbids private kinds; ~35 events
    needed a home. Resolved by PR jahala/plotplot#19 (merged): `run.lifecycle`, `node.lifecycle`,
    `gate.result`, and the `plotplot.runner` attribute.

### weeder

23. `weeder check --strict` on the (docs-only) dirty tree: exit 0, SARIF 2.1.0 on stdout, zero
    results, nothing on stderr — the smoke gate this order mandates behaves as a gate should. No
    findings against weeder from shaping; the run will tell.

## Conducting

(filled as the run happens)
