import type { Check, LoopSpec } from '../make-plan.ts';

const GROUND = [
  "Ground truth, read before shaping: settle in src/loop/run-plan.ts already keeps artifacts beside the receipt through ReceiptStore.writeArtifact(node, kind, bytes) with ArtifactKind 'sarif' | 'friction' (D14; keepArtifactsOrJournal / keepOrJournal — one keep-or-journal path, a failure of one never loses the other; discardArtifact when a close keeps nothing). The builder's WorkerResult.finalMessage reaches run-plan on RunNodeResult only through the verdict's evidence today — run-node reads it for hygiene and audit egress; extend RunNodeResult to carry it (journal/settle material only, the Verdict contract untouched). src/seams/receipts.ts write() overwrites <node>.json; run-plan's writeReceiptOrJournal already reads the prior receipt and sets refs.previousReceiptSha256. Retries: run-node's attempt loop re-spawns through deps.runner.spawnWorker({provider: node.worker.provider, model, cwd}); dead+resume (policy.onDead) re-isolates and re-spawns identically; classify: dead → 'dead', timeout → retryable. runAudit (run-node.ts) bounds reaudits by REAUDIT_BUDGET=2 and journals audit-egress-unparseable {node, reaudit, egress: tail}; 'parse-exhausted' fails the node. The CLI (src/faces/cli.ts) has verbs run/land/stop/validate/schema/receipt/clean; flags parsed in parseFlags. Isolation: IsolateSeam.isolate(node, baseRefs) — baseRefs[0] is the checkout base, the rest merged (run-plan's baseRefsFor). quarantine/<id> is committed by quarantineOrJournal with a receipt-sha256 trailer. The contract (docs/contract/plan-schema.md) is NOT touched by this loop: no plan field for the fallback, no schema change; Receipt is pleach's own (additive fields are recorded in CHANGES.md as 'Receipt, not schema').",
].join(' ');

const checks: Check[] = [
  {
    n: 1,
    id: 'nl.handback',
    claim:
      "Settle keeps the final attempt's handback verbatim as `<node>.handback.md` beside the receipt on both the done and quarantine paths, journals `gate-artifact` with `gate: 'handback'`, the receipt names it under `artifacts.handback`, and a write failure journals `receipt-write-failed` with the close standing",
    evidence: 'test/loop/handback-kept.test.ts',
    needs: [],
    how: `ArtifactKind gains 'handback' (src/loop/deps.ts; the store maps it to \`.handback.md\` in src/seams/receipts.ts; the harness store in test/loop/harness.ts follows). run-node carries the final attempt's finalMessage on RunNodeResult (e.g. \`handback?: string\`, set from the build worker's result on every hand-back and on done). run-plan's keepArtifactsOrJournal keeps it through keepOrJournal with gate 'handback' and sha256Hex(bytes) — verbatim, never interpreted (agents produce; code decides: pleach keeps the message, nothing in pleach reads a Tried line). Receipt.artifacts gains \`handback?: string\`. An empty finalMessage keeps nothing (and discards a stale one, as the SARIF path does). Prove on the harness: done and quarantine paths both keep it; the journal line; the receipt names it; a throwing store journals receipt-write-failed and the close stands. ${GROUND}`,
  },
  {
    n: 2,
    id: 'nl.receipt-history',
    claim:
      "The receipt store keeps every close: `<node>.json` is the latest and `<node>.<sha256 prefix>.json` is each close's own; artifacts follow the same naming; `pleach receipt <node>` verifies the latest and lists the history through `previousReceiptSha256`",
    evidence: 'test/integration/receipt-history.test.ts',
    needs: ['nl.handback'],
    how: `src/seams/receipts.ts: write() lands \`<node>.<first 12 hex of receipt.sha256>.json\` AND \`<node>.json\` (latest); writeArtifact/discardArtifact take the receipt's sha prefix too (the store owns the names: \`<node>.<prefix>.sarif\`, and the un-prefixed name stays the latest) — extend the ReceiptStore interface additively and keep every existing caller working (the harness store included). src/loop/receipt-verify.ts (the receipt verb): verify the latest as today and, when refs.previousReceiptSha256 is set, follow it through the history files and print one line per prior close (status, derived, sha prefix). Prove against the real store in a tmp dir: two closes of one node id leave two history files and one latest; the artifact of the first close is not the second's; the verb lists both. ${GROUND}`,
  },
  {
    n: 3,
    id: 'nl.fallback',
    claim:
      "A `dead` attempt retries on `--fallback-provider` with the audit diversity rule re-checked against it; without a fallback the node settles after one such attempt with `gate.ran: 'wait:dead'` and no second spawn; a smoke-red attempt still retries on the same provider",
    evidence: 'test/loop/fallback-provider.test.ts',
    needs: ['nl.receipt-history'],
    how: `Conductor-level, not a plan field: src/faces/cli.ts adds \`--fallback-provider <name>\` (optional) threaded through RunPlanOpts → RunNodeOpts as \`fallbackProvider?: string\`. In run-node's dead+resume branch: if a fallback is set and differs from the attempt's provider, the re-spawn uses it (and the audit diversity preflight is re-checked: accept.audit.provider must still differ from the RESOLVED provider — a PlanInvalidError-shaped refusal if not, settled as failed with the reason named); if no fallback, do NOT consume a second attempt on the same dead provider — settle after this attempt with the dead verdict as today's terminal dead path does (gate.ran 'wait:dead'), and say why in the verdict's journal line (detail: 'no fallback provider; the second attempt would have spent the same dead provider'). Timeouts and gate reds keep today's same-provider retry. Prove on the harness with a waitScript that answers dead on attempt 1: with a fallback the second spawn's provider is the fallback and the node closes; without, exactly one spawn and a dead verdict; a smoke-red first attempt still re-spawns the original provider. ${GROUND}`,
  },
  {
    n: 4,
    id: 'nl.audit-verb',
    claim:
      '`audit-egress-unparseable` names the expected block and shows the tail; `pleach audit <plan> <node>` re-runs only the audit on a quarantined node whose receipt shows a green smoke, seeding from `quarantine/<id>`, and closes or re-quarantines it with a new receipt',
    evidence: 'test/e2e/audit-verb.test.ts',
    needs: ['nl.fallback'],
    how: `(a) runAudit's audit-egress-unparseable line gains \`expected: 'a fenced tend-audit-result block'\` and keeps the tail. (b) A new verb \`pleach audit <plan.json> <node> [--repo-root]\` in src/faces/cli.ts, with its loop in src/loop (e.g. audit-node.ts, composing injected seams like land.ts does): refuse unless the node's latest receipt is quarantined with a green smoke gate and quarantine/<id> exists (typed error → exit 1); isolate from quarantine/<id> (dependencies merged as run-plan's baseRefsFor would), run setup, then ONLY the audit ladder (SEC4a tamper rule + runAudit); on pass: commit-before-emit to node/<id> with a fresh receipt whose facts.base records the quarantine sha, emit the verdict, journal closed; on fail: a new quarantine receipt. Reuse run-node's audit code by extracting runAudit's caller into a function both paths share — do not duplicate the ladder. Prove through the real CLI with a scripted runner whose first auditor relays garbage (node quarantined, smoke green) and whose second relays a pass: \`pleach audit\` closes it, node/<id> exists, the receipt history shows both. ${GROUND}`,
  },
  {
    n: 5,
    id: 'nl.resume',
    claim:
      '`pleach run` resumes an unverified node from `quarantine/<id>` by default: the tree is isolated from the quarantine with dependencies merged, every gate runs from the marker scan on, the receipt records `facts.base` as the quarantine sha, `resumed-from-quarantine` is journaled, and `--fresh` re-isolates instead',
    evidence: 'test/loop/resume-quarantine.test.ts',
    needs: ['nl.audit-verb'],
    timeoutMs: 2_700_000,
    how: `The rule first (docs/ledger.md D17 states it): a quarantined tree was never gated, so a resumed attempt re-runs EVERY gate (marker, staging/hygiene, smoke, audit) — nothing about the quarantine is trusted except that it is the worker's own work — and the receipt records \`facts.base: { kind: 'quarantine', sha }\` (additive ReceiptFacts field; absent for fresh isolations; CHANGES.md 'Receipt, not schema' note) so a resumed close is distinguishable forever. Mechanism: run-plan's baseRefsFor, for an unverified node whose quarantine/<id> resolves (isolate.refSha) and when opts.fresh is not set, puts the quarantine sha FIRST (the checkout base) and the dependencies' closed shas after it (merged as today); journal {event:'resumed-from-quarantine', node, sha} (KINDS: node.lifecycle; docs/journal.md row); run-node's first prompt carries evidence 'resuming work interrupted at <sha>: <diff stat>' (the diff stat through the isolate seam). A phased node resumes at its phase ladder's start (the seal state belongs to the tree: a quarantine that contains a red commit is a tree whose red is already sealed — reuse redSealedAt by asking the seam whether HEAD carries the pleach-phase: red trailer). \`--fresh\` at the CLI skips all of it. Prove on the harness (refs + closed maps): the quarantine sha is baseRefs[0], every gate ran, facts.base recorded, the journal line, and --fresh yields today's behaviour byte-identical. ${GROUND}`,
  },
  {
    n: 6,
    id: 'nl.docs',
    claim:
      'docs/journal.md documents `resumed-from-quarantine` and the `handback` artifact; `KINDS` pins the event; the CLI help and README list `pleach audit`, `--fallback-provider` and `--fresh`',
    evidence: 'test/unit/journal-doc.test.ts',
    needs: ['nl.resume'],
    how: `The pin test exists; make it red first (assert the help text names the verb/flags if the doc parts are already green from siblings), then docs/journal.md (the row, the artifact kinds in the gate-artifact row, the run-end/verdict rows if touched), README verbs and flags, the help block in src/faces/cli.ts; keep test/e2e/help.test.ts green. ${GROUND}`,
  },
  {
    n: 7,
    id: 'nl.e2e',
    claim:
      'Through the real CLI with real git: an aborted phased node resumes from its quarantine and closes verified with `facts.base` set and its handback kept; the receipt history holds both closes; `pleach audit` re-adjudicates a node whose auditor relayed garbage',
    evidence: 'test/e2e/nothing-is-lost.test.ts',
    needs: ['nl.docs'],
    timeoutMs: 2_700_000,
    how: `Model on test/e2e/teardown.test.ts (D16: SIGINT mid-node → aborted receipt + quarantine) and test/e2e/phases.test.ts (the scripted runner). (a) Run a phased node, SIGINT it after its red seal, re-run the plan: the node resumes from quarantine/<id> (journal resumed-from-quarantine), closes verified, its receipt has facts.base with the quarantine sha and artifacts.handback, the history dir holds the aborted close and the verified close. (b) A node whose scripted auditor relays garbage is quarantined with a green smoke; \`pleach audit <plan> <node>\` with a fixed auditor closes it. This node is the sink of the loop: its audit verifies EVERY check on the page; if a sibling's check reads red here, fix it here and say so in Tried. ${GROUND}`,
  },
];

const spec: LoopSpec = {
  loop: 'docs/tend2/nothing-is-lost.tend2.html',
  payload: '56abbf4fb360',
  title: 'Nothing a worker produced is lost',
  goal: 'Every close keeps what the worker handed back, every close keeps its own receipt, a provider outage is paid once, an unparseable audit relay costs one auditor turn, and a re-run can resume from a quarantined tree when the acceptance rules say what that tree proves.',
  ledger: 'D17',
  sink: 'nl.e2e',
  checks,
};

export default spec;
