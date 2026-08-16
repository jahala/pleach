---
name: pleach-plan
description: Author a valid pleach plan.json from a goal and a target repo — decompose into parallel DAG nodes with gates (smoke, cross-provider audit, TDD phases), then prove it with `pleach validate` before handing over. Use when the user wants to run something through pleach, asks to "make a plan for pleach", or has a feature to build via verified agent work.
---

# pleach-plan — author a plan.json that pleach will actually verify

You are writing the input contract for a deterministic conductor. pleach will
isolate each node in a git worktree merged from its dependencies' verified
branches, enforce the gates you declare, and publish only verified work. A weak
plan wastes agent runs; a good one parallelizes cleanly and verifies honestly.

## Procedure

1. **Ground in the real schema — never guess it.** Run `pleach schema` (or
   `bun src/main.ts schema` inside the pleach repo) and read the output. The
   schema is the contract; this skill only adds judgment.

2. **Read the target repo before decomposing.** Find: the test command
   (`package.json` scripts, CI config), the dependency-install command, the
   files the goal touches, and any existing conventions an agent must follow.
   Node prompts are the ONLY context the build agents get — they see no
   conversation, no other nodes.

3. **Decompose into a DAG.** Rules of thumb:
   - **Parallel siblings** for work on separable concerns. Two siblings editing
     the SAME file is fine — pleach merges their branches into the dependent's
     worktree and surfaces conflicts to that node's agent. Plan for it: give
     the joining node a "resolve the merge, keep both sides' work" instruction.
   - **One terminal integration node** (`needs: [all siblings]`) that joins the
     work, adds what only makes sense on the union, and carries the audit.
     `pleach land` merges sinks — fewer sinks, cleaner landing.
   - Node ids: short, dot-separated (`feature.s1`, `feature.s2`, `feature`) —
     they become git branch names.
   - 3–6 nodes is the sweet spot. One node = pleach adds only verification;
     ten = the decomposition is probably guesswork.
   - **Anti-conformity** (identical models make identical choices): keep
     siblings' helper surface disjoint — two siblings that each "helpfully"
     write the same util will merge cleanly and duplicate logic, which no gate
     catches. Name in each sibling's prompt what it must NOT create, and have
     the integration node's prompt check for duplicated logic after the merge.

4. **Choose each node's work shape:**
   - `{ command }` — deterministic steps (codegen, scaffolding). Exit-code
     gated, no agent, no runner needed.
   - `{ prompt }` — agent work (the default). Write the prompt test-first:
     name the exact files to create/edit, the assertions the tests must make,
     what must NOT be modified, and the command that must pass.
   - `{ test, phases }` — the enforced TDD cycle: pleach itself runs `test`
     after the red phase (MUST fail — a passing "failing test" fails the node)
     and after green (MUST pass). Strongest guarantee; needs a multi-turn
     runner (umbel), NOT `--runner direct-cli` (single-turn).

5. **Declare the gates:**
   - `setup`: the dependency install (e.g. `bun install`) — runs once per
     isolate, before work and gates. Without it, fresh worktrees fail tests
     for the wrong reason.
   - `accept.smoke`: the project's real test command. Every node gets one.
   - `accept.audit` on the integration node: `command` is a deterministic
     check script/command; `provider` MUST differ from the builder's
     (claude builds → `"codex"` audits). The auditor runs the command in an
     independent session and relays its verdict block — execution isolation,
     not model judgment.
   - `policy.timeoutMs`: set it (e.g. 600000). `policy.maxAttempts`: 2 —
     retries carry the failure evidence into the re-prompt.

6. **Prove the plan before handing it over — non-negotiable:**
   ```
   pleach validate plan.json
   ```
   Must exit 0. Fix every reported issue (cycles, unknown needs, duplicate
   ids, audit provider = builder provider) and re-run. Show the user the
   printed `waves` — that is the parallelism they'll get.

7. **Hand over:** write `plan.json` at the repo root (or the path the user
   named), and tell the user the run command that fits their setup:
   - lean: `pleach run plan.json --runner direct-cli` (claude + codex CLIs
     on PATH; `{phases}` nodes need umbel instead)
   - strict: `pleach run plan.json` (umbel + tmux)
   - and the last mile: `pleach run plan.json --land` or `pleach land
     plan.json` after a verified close.

## Prompt-writing checklist (per agent node)

- Self-contained: repo layout, file names, exports, test file locations.
- Test-first phrasing: "ADD failing tests FIRST … then implement … run
  <test cmd> — all green before you stop."
- Explicit constraints: "do NOT modify X", "ADD, do not replace".
- For the integration node: name the expected merge ("this worktree merges
  branches A and B into <file>; resolve conflicts keeping ALL functions").

## Failure modes to avoid

- A node whose smoke can pass without the work existing (tautological gate).
- Siblings with hidden dependencies (B imports what A creates but no `needs`
  edge — B's worktree won't contain A's work).
- Prompts that reference "the conversation", other nodes, or files the seed
  repo doesn't have.
- An audit provider equal to the resolved builder provider — validate rejects
  it (model diversity is the point).
