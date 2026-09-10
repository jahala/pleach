import type { Check, LoopSpec } from '../make-plan.ts';

const GROUND = [
  "Ground truth, read before shaping: src/core/argv.ts exports toArgv(command) (POSIX-quoting split) and shellOperatorTokens(tokens) (bare &&, ||, |, ;, >, >>, < tokens); src/loop/run-work.ts guardedExec uses both and returns exitCode -1 with the escape-hatch message (`bash -lc '<command>'`) without exec'ing; src/seams/exec.ts resolves a spawn failure (missing binary, bad cwd) as exitCode 127 with the error text as output. src/core/validate.ts validatePlan(plan) → {order, waves} throws PlanInvalidError(reasons[]) (exit 2 at the face) and already checks ids, needs, cycles, audit-provider diversity; planWarnings(plan) exists (D13). run-node.ts: setup and smoke gates go through execGateWithRetry (one flaky retry) then settleRetryable (a red gate retries the worker with evidence up to policy.maxAttempts); classify has no notion of 'cannot exec'. src/core/hygiene.ts checkDiffHygiene runs the secrets battery over the staged diff (the AKIA case refused a test at close on 2026-09-09). src/core/schema-json.ts planJsonSchema() derives JSON Schema from the zod Plan; policy uses .default()/.prefault({}) and Node has worker/needs/accept/policy/closes with defaults — the emitted `required` lists them (#68). ReceiptFacts.stagedFiles = stagedFiles.length where stagedFiles = the collected set handed to isolate.stage (touched ∪ changed, after partitionDelivery); the seam has stagedDiff/stagedNumstat over `git diff --cached`. The verdict journal line (run-plan.ts settle) carries provider (resolved, never absent — docs/journal.md's stability promise) and model?; a {command} node spawns no worker (run-node: worker === null). weeder's rule catalogue (weeder rules, X1) is the published secret rule set; its documented-example allowlist, if present in /Users/jahala/conductor/repos/weed/src (a private checkout on this machine only — read it if it is there, cite it, never import it), is the reference for the vendored list; otherwise vendor AWS's documentation pair (AKIAIOSFODNN7EXAMPLE / wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY), GitHub's and Stripe's documented test tokens from their public docs, each with a provenance comment. The Plan schema is untouched by this loop.",
].join(' ');

const checks: Check[] = [
  {
    n: 1,
    id: 'fb.validate-commands',
    claim:
      "`validatePlan` refuses a bare shell operator in any of `work.command`, `work.test`, `setup`, `accept.smoke` with the exec path's own tokenizer and message; `pleach validate` exits 2 naming the node and the command; `pleach run` refuses before taking the lock",
    evidence: 'test/unit/validate-commands.test.ts',
    needs: [],
    how: `In src/core/validate.ts, inside validatePlan (so run and validate share one refusal), for each node walk the four command fields that exist on it and call toArgv + shellOperatorTokens (import from ./argv.ts — core imports core); a hit becomes one PlanInvalidError reason: "node '<id>': <field> contains bare shell operator(s): && — pleach execs without a shell; for shell features wrap the command: bash -lc '<command>'" (reuse guardedExec's wording — extract the message into core/argv.ts so both sites share it). \`accept.audit.command\` is NOT checked (the contract says it is relayed to the auditor's shell). Prove: a plan with && in the smoke is refused naming node + field; one wrapped in bash -lc passes; validate's JSON output is unchanged for a clean plan; run-plan refuses before lock.acquire (harness event log shows no acquire). ${GROUND}`,
  },
  {
    n: 2,
    id: 'fb.cannot-exec',
    claim:
      "A gate that cannot run at all — the no-shell guard's exit -1 or the exec seam's 127 before any command started — settles the node on that attempt with `gate.ran` naming the command and `detail` naming the fault as the plan's or the environment's, no second attempt, no worker re-prompt; a gate that ran and failed keeps today's retry",
    evidence: 'test/loop/gate-cannot-exec.test.ts',
    needs: ['fb.validate-commands'],
    how: `ExecResult already distinguishes the cases by exit code (-1 guard, 127 spawn failure); make that explicit and total: a small pure classifier in core (e.g. core/classify.ts \`gateFault(exitCode)\` → 'plan' | 'environment' | null) used by run-node's setup and smoke gates: when a gate's exit is -1 or 127, do NOT go through settleRetryable — hand back a failed verdict now with gate.ran = the command and a \`detail\` (RunNodeResult.verdictDetail, D17) such as "the plan's gate cannot run: <tail>" / "the environment cannot run the gate (command not found): <tail>", attempts as they stand, tree quarantined as any failed node. A gate that ran and exited non-zero keeps today's retry-with-evidence. The flaky retry (execGateWithRetry) must not re-run a -1/127 either. Prove on the harness with execScript answering -1 / 127 / 1: one spawn only for the first two (no re-prompt), the verdict's detail names the fault, and exit 1 keeps the retry. ${GROUND}`,
  },
  {
    n: 3,
    id: 'fb.allowlist',
    claim:
      'The secret scan allowlists the documented example credentials (AWS, GitHub, Stripe), vendored with provenance: a test quoting one passes hygiene, a live-shaped key is still refused, and the allowlist is exact-match, never a pattern',
    evidence: 'test/unit/hygiene-allowlist.test.ts',
    needs: ['fb.cannot-exec'],
    how: `In src/core/hygiene.ts, beside the secrets battery, an exact-match set DOCUMENTED_EXAMPLE_CREDENTIALS with one provenance comment per entry (the public doc page each comes from): AWS's documentation pair, GitHub's documented example tokens, Stripe's documented test keys. A detector hit whose matched text is in the set is not a finding. Exact match only — a pattern would be an answer key. Prove: a diff quoting AWS's documentation key passes; the same diff with one character changed is refused as today; the set has provenance for every entry (assert the comment/field exists). Read weeder's list at the path in the ground truth if present and cite it; do not import anything from it. ${GROUND}`,
  },
  {
    n: 4,
    id: 'fb.schema-optional',
    claim:
      '`pleach schema` emits every zod-defaulted field as optional (`policy.maxAttempts`, `onDead`, `reauditWhen`; `worker`, `needs`, `accept`, `policy`, `closes`), and a minimal plan that the validator accepts validates against the emitted schema',
    evidence: 'test/unit/schema-optional.test.ts',
    needs: ['fb.allowlist'],
    how: `src/core/schema-json.ts: when deriving the required list, exclude fields whose zod type carries a default (ZodDefault / prefault) — inspect the zod v4 def (\`_zod.def.type === 'default'\` / 'prefault'); keep everything else as is; the drift test and src/core/plan.ts are untouched. Prove: the emitted schema's Node.required and policy.required omit the defaulted fields; a minimal plan {goal, source, nodes:[{id, work:{prompt}}]} that PlanSchema.parse accepts validates against the emitted JSON Schema with a small in-test validator over required/properties (no new dependency — zod is the only one; a hand-rolled check of the required list against the object's keys is enough for this claim). ${GROUND}`,
  },
  {
    n: 5,
    id: 'fb.facts',
    claim:
      '`ReceiptFacts.stagedFiles` counts the paths the index holds after staging (the seam answers from the index, not the touched set), and every `verdict` journal line carries `spawned` — `false` for a command node, `true` when a worker spawned — beside the cast it names',
    evidence: 'test/loop/facts-are-facts.test.ts',
    needs: ['fb.schema-optional'],
    how: `(a) IsolateSeam gains \`stagedPaths(cwd): Promise<string[]>\` (\`git diff --cached --name-only\`; the harness answers from what stage() received ∩ its changed set); run-node records lastStaged from it after stage(), so ReceiptFacts.stagedFiles counts the index. (b) RunNodeResult gains \`spawned: boolean\` (true when deps.runner.spawnWorker was called on the final attempt); run-plan's verdict journal line carries \`spawned\`; provider/model stay exactly as documented (never absent). Prove on the harness: a worker that reports touching a file it did not change → stagedFiles counts only the changed; a {command} node's verdict has spawned false and its provider is the cast; a prompt node has spawned true. ${GROUND}`,
  },
  {
    n: 6,
    id: 'fb.docs',
    claim:
      "docs/journal.md documents `verdict`'s `spawned`; README and the CLI help state that validate refuses shell operators and that a gate that cannot run fails once",
    evidence: 'test/unit/journal-doc.test.ts',
    needs: ['fb.facts'],
    how: `The pin test exists; extend it first with the assertion that makes it red (the verdict row names spawned; the help text names the two refusals), then docs/journal.md, README (the validate and gates paragraphs), the help block in src/faces/cli.ts; keep test/e2e/help.test.ts green. ${GROUND}`,
  },
  {
    n: 7,
    id: 'fb.e2e',
    claim:
      "Through the real CLI: `pleach validate` on a plan with `&&` in its smoke exits 2 before anything runs; `pleach run` on a plan whose smoke names a missing binary fails the node after one attempt with the fault named and no second worker; `pleach schema` output validates that plan's minimal sibling",
    evidence: 'test/e2e/fail-before-spend.test.ts',
    needs: ['fb.docs'],
    timeoutMs: 2_700_000,
    how: `Model on test/e2e/cli.test.ts and test/e2e/quarantine.test.ts ({command} nodes need no runner). (a) validate with && → exit 2, stderr names the node and field, no journal written. (b) run with smoke 'definitely-not-a-binary-xyz --flag' on a {command} node → exit 1 after ONE attempt (journal: one node-start, one verdict with detail naming the environment, no gate-retry), receipt quarantined. (c) \`pleach schema\` → parse the JSON, assert the defaulted fields are absent from required, and check the minimal plan's keys against it. This node is the sink of the loop: its audit verifies EVERY check on the page; if a sibling's check reads red here, fix it here and say so in Tried. ${GROUND}`,
  },
];

const spec: LoopSpec = {
  loop: 'docs/tend2/fail-before-spend.tend2.html',
  payload: '536cafb89f18',
  title: 'A fault in the plan is refused before a worker costs anything',
  goal: "pleach validate refuses every command string the conductor would refuse at exec; a gate that cannot run at all fails the node once, naming the plan, never re-prompting a worker for it; the secret scan knows the documented example credentials; pleach schema agrees with the validator about what is optional; and the receipt's facts are the facts — the staged count is what the index holds, and a verdict says whether a worker ever spawned.",
  ledger: 'D19',
  sink: 'fb.e2e',
  checks,
};

export default spec;
