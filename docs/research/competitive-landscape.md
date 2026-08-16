# pleach — competitive landscape & right-of-life assessment

**Date: 2026-08-16.** Five parallel research agents surveyed the field (local worktree managers,
Claude-native swarm orchestrators, general agent frameworks, cloud agentic platforms, and a wide
sweep for direct equivalents); facts verified against repos and current sources, not marketing.
Synthesis and the call are the lead's, made against pleach's actual code and test evidence.

---

## What pleach is, in one paragraph

A deterministic conductor for DAGs of verified agent work: it takes a plan (nodes + dependency
edges), isolates each node in a detached git worktree **merged from its dependencies' verified
branches**, enforces gates (conflict-marker scan fails closed, smoke command, cross-provider audit
where a *different model vendor* runs the check command and relays a machine-parsed verdict), and
publishes a `node/<id>` branch **only for verified work**. Prime invariant: agents produce; code
decides — close/verify/retry are deterministic code paths, never LLM judgment. ~8k lines of strict
TypeScript, one dependency (zod), 227 tests green across unit/integration/loop/e2e, and a completed
real-agent proof run (claude builds → codex audits → tend verifies → pleach closes).

## Ground truth on "will it work"

It already does, at proof scale. Verified in this assessment (not from docs alone):

- `bun run check` green today: 227 pass / 0 fail, e2e drives the real CLI against real git and
  fake worker binaries in CI; the deterministic backbone cannot silently rot.
- The proof run (`docs/research/proof-run.md`) closed a real multi-step feature end-to-end with
  real claude builders, a real codex auditor, and real tend — including the honest-middle case
  (undiscriminated check correctly capped at `partial`, then correctly `verified` once the
  negative control discriminated).
- The code matches the doctrine line-for-line: commit-before-emit, SHA pinning against ref
  tampering (a worker that force-moves `node/<dep>` triggers rebuild-required, not silent trust),
  fail-closed gates, evidence-carrying retries. Every defect in `docs/ledger.md` maps to a test.
- The in-progress `examples/three-ways/` work removes the umbel/tmux lock-in: a ~40-line headless
  runner (`claude -p` / `codex exec`) or the in-process Agent SDK both satisfy `RunnerSeam`.

Open, honest gaps: the last mile is manual (verified work sits on `node/<id>` branches; nothing
lands it on the user's branch — B3's landing-policy flag is unimplemented); plan authoring is
upstream (tend's exporter or hand-written JSON — pleach is an engine that needs a planner);
single-machine, single-process; no UI beyond the JSONL journal.

## The field, cluster by cluster

| Cluster | Representatives | What they share with pleach | What none of them have |
|---|---|---|---|
| Worktree session managers | claude-squad (8.3k★, AGPL), vibe-kanban (27.8k★, company dead), Conductor.build (closed), Crystal (EOL'd), uzi (dormant) | The isolation primitive: worktree per agent | Dependency edges, any automated gate, cross-model audit — every one ends at a human clicking merge |
| Claude-native swarms | claude-flow/ruflo (68k★), gastown (17.6k★), claude-task-master (28k★), Anthropic subagents/Outcomes | gastown: real worktrees, `needs=[...]`, Bors-style merge queue | Cross-vendor **audit** (gastown's multi-vendor is who *builds*, not who *checks*); deterministic close (Anthropic's Outcomes grades with an LLM — the opposite invariant); claude-flow's "verification/Byzantine consensus" is vocabulary without mechanism |
| General frameworks | LangGraph ($1.25B), CrewAI, AutoGen (maintenance mode), Temporal | Nothing domain-level — different layer | Any notion of git, branches, merge-from-dependency, test-gated artifacts; you would build all of pleach on top |
| Cloud platforms | GitHub gh-aw/Copilot agent, Codex cloud, Cursor cloud agents, Devin ($26B), Factory.ai | Per-task sandboxing (now table stakes) | Dependency-ordered DAG builds; deterministic promotion (it's a human click or an LLM manager's judgment); local-first; bring-your-own-runner |
| Direct equivalents (wide sweep) | **Bernstein** (907★, Apache-2.0, active) — the single closest competitor; also Taskplane, LoopTroop, trellis-cli (13.9k★, prose deps only), loki-mode | Bernstein: real wired cross-model audit gate, DAG-gated task claiming, evidence-fed retries | Bernstein serializes onto one shared trunk — it gates *when* a task starts, not *what a node's worktree is built from*. Per-node merge-from-named-verified-branches + SHA-resumable nodes remain pleach-only |

**Conclusion from the sweep: no project is pleach.** The specific combination — merge-from-verified
DAG isolation + mandatory cross-vendor audit + deterministic close — exists nowhere else found.

## Honest read

**Where pleach is genuinely differentiated.** The exact point it occupies is empty, and — more
telling — the field's visible failures are precisely the thing pleach built. gastown's field
reports describe failing tests auto-merged to main and force-push recoveries: gates that don't
hold. claude-flow's verification language is unbacked. Anthropic and Devin both chose LLM judgment
for promotion. The industry converged on isolation (easy) and skipped verification discipline
(hard). pleach's 8k lines are almost entirely the hard part, built defect-ledger-first with an
adversarial review *before* the first commit — a method none of the compared projects show evidence
of.

**Where it is outmatched.** Distribution and surface. claude-flow has 68k stars on vocabulary;
trellis has 13.9k with prose dependencies. pleach has no UI, no community, and its strongest
demo requires two vendor subscriptions. The category also churns violently: of the five worktree
managers, two are dead and one lost its company — VC-backed products with real users didn't
survive. And the giants are drifting toward the invariant: Codex's `/goal` reportedly uses
deterministic shell acceptance tests; gh-aw's safe-outputs job is a permission-scoped gate. If
GitHub or Anthropic ships "publish-only-verified DAG builds" natively, pleach's moat is its
tool-agnosticism and local-first posture, not the mechanic itself.

**Devil's advocate — why pleach might not be needed.** (1) Most agent work today is single-task,
human-reviewed; a DAG of verified nodes may be solving next year's problem at this year's agent
quality — or the window may close from the other side if frontier agents get reliable enough that
per-node verification feels like ceremony. (2) The engine needs a planner; without tend maturing
(or an LLM planner emitting good plans against `pleach schema`), the fuel supply is thin.
(3) Bernstein exists, is active, and clears the "deterministic cross-vendor-audited pipeline" bar
today — the per-node-merge distinction is real but takes a paragraph to explain.

**What survives it.** The invariant is not ceremony — the proof run's own history shows the gates
catching real defects (egress relay, undiscriminated checks) that prose review would have passed.
The failure mode pleach prevents (garbage propagating down a dependency chain) gets *worse* with
scale and autonomy, not better. And every adjacent project that claims verification either
outsources it to an LLM or doesn't hold under load — the market keeps proving the thesis it fails
to build.

## The call: **build** (continue) — narrowly

pleach has right of life. The single strongest reason: **it is the only project found that
enforces "publish only verified work, decided by code" — and the documented failures of its
nearest neighbors are exactly the absence of that invariant.**

Narrowness matters:

- **Stay the engine.** Do not chase fleet-management UX (gastown/AO/vibe-kanban's turf — crowded,
  churning, and orthogonal). pleach's durable value is the boring, tested loop underneath.
- **The three-ways work is the right bet** — the direct-CLI runner turns "needs the plotplot
  stack" into "needs claude + codex on PATH," which is the difference between a suite-internal
  tool and an adoptable one.
- **The last mile (B3 landing flag) is the highest-leverage missing feature** — "verified but
  stranded on node branches" is the first wall every real adopter hits.
- **Track Bernstein**; it is the one project worth benchmarking against.

## Sources

Agent reports (2026-08-16) verified against: github.com/smtg-ai/claude-squad ·
github.com/BloopAI/vibe-kanban · conductor.build · github.com/ruvnet/ruflo ·
github.com/gastownhall/gastown (+ paddo.dev field report) · github.com/eyaltoledano/claude-task-master ·
code.claude.com/docs (subagents, Outcomes) · github.com/langchain-ai/langgraph (+ Open SWE) ·
crewai/AG2/Temporal docs · githubnext.github.io/gh-aw · OpenAI Codex cloud docs · Cursor cloud
agents docs · cognition.ai (Multi-Devin) · factory.ai (Code Droid report) ·
github.com/sipyourdrink-ltd/bernstein · mindfold-ai/Trellis · HenryLach/taskplane ·
looptroop-ai/LoopTroop · asklokesh/loki-mode.
