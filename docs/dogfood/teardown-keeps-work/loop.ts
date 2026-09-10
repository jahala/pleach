import type { Check, LoopSpec } from '../make-plan.ts';

const GROUND = [
  'Ground truth, read before shaping (do not re-derive from memory): the real umbel adapter (src/adapters/umbel.ts, wait()) throws WorkerSeamError on ANY non-zero exit of `umbel wait`, including the exit the run\'s own AbortSignal causes when the exec seam (src/seams/exec.ts) SIGKILLs the process on abort; the in-memory runner in test/loop/harness.ts returns {reason:"aborted"} instead, which is why test/loop/abort.test.ts (D12) is green over a path the real seam never takes. run-node.ts catches only GateFailedError around runWork; any other throw kills the worker, rethrows, and the function\'s finally disposes the tree (no hand-back, no quarantine). run-plan.ts runOne() maps a rejected node promise to a bare `verdict: failed` journal line with `detail` — no receipt, no summary bucket but `failed`. The scheduler (run-plan.ts, "scheduler loop") launches the next ready node in the same tick as a close, checking only `opts.signal?.aborted`. The lock seam (src/seams/lock.ts) owns lockPath(repoRoot, source), readPid(), isAlive(). `umbel wait --json --idle-timeout 5s <name>` exits 0 and prints {"reason":"idle"} (verified 2026-09-11); the adapter already maps idle → blocked with the message as blockedReason (gatherWorkerResult). classify (src/core/classify.ts): aborted → terminal, idle → blocked. The contract already has Verdict.status "aborted" (docs/contract/plan-schema.md) — no schema change anywhere in this loop.',
].join(' ');

const checks: Check[] = [
  {
    n: 1,
    id: 'tk.adapter-abort',
    claim:
      "The umbel adapter's `wait` returns `reason: 'aborted'` when the run's signal interrupts it, proven against the real umbel binary and a fake worker that never stops; a non-signal non-zero exit is still a `WorkerSeamError`",
    evidence: 'test/integration/umbel-abort.test.ts',
    needs: [],
    how: `In src/adapters/umbel.ts wait(): after exec returns, if waitOpts.signal?.aborted is true, return gatherWorkerResult(name, cwd, 'aborted', undefined) — or the minimal WorkerResult {reason:'aborted', finalMessage:'', filesTouched:[], telemetry:{}} if gathering from a killed wait is unsafe — BEFORE the non-zero-exit check; every other non-zero exit stays a WorkerSeamError. Model the integration test on test/integration/umbel-seam*.test.ts / the fake-claude.sh pattern in test/fixtures: spawn through the real adapter with a fake worker that never writes its stop event, call wait({timeoutMs: 30000, signal}) and abort the signal after ~200 ms; assert reason === 'aborted' promptly and that the session is still killable by the caller. Also assert the negative: a wait that exits non-zero WITHOUT the signal (e.g. a bogus session name) still throws WorkerSeamError. ${GROUND}`,
  },
  {
    n: 2,
    id: 'tk.settle-aborted',
    claim:
      "An in-flight node whose wait returns `aborted` settles with `Verdict.status: 'aborted'` and `gate.ran: 'wait:aborted'`, its receipt written (derived `quarantined`), its tree quarantined as it stands (staged and unstaged work on `quarantine/<id>`), `RunSummary.aborted` naming it and the exit code not clean",
    evidence: 'test/loop/abort-settles.test.ts',
    needs: ['tk.adapter-abort'],
    how: `run-node.ts non-stop branch: for klass 'terminal' with reason 'aborted', hand back {verdict: {...baseVerdict, status:'aborted', evidence:{...gate:{ran:'wait:aborted', exitCode:-1}}}} with the live tree (never throw into the finally). The same for an aborted AUDIT wait (runAudit's worker-fault with reason 'aborted' → status 'aborted', not 'failed'). run-plan.ts: RunSummary gains \`aborted: string[]\` (additive; src/loop/deps.ts + the run-end journal line + docs/journal.md's run-end row), settle's non-done path adds the node to \`aborted\` (not \`failed\`) when verdict.status === 'aborted' and otherwise proceeds exactly as today (receipt mint + write, quarantineOrJournal, dispose); src/faces/cli.ts summaryExitCode treats a non-empty aborted as not clean. Prove on the in-memory harness (its runner already returns aborted on signal): abort mid-wait → verdict status aborted with gate.ran wait:aborted, receipt written with derived quarantined, a quarantine commit carrying the tree's changed files, summary.aborted === [id], summary.failed === [], exit code 1; and the existing abort.test.ts stays green. ${GROUND}`,
  },
  {
    n: 3,
    id: 'tk.drain',
    claim:
      'A stop marker read through the lock seam in the same tick as every launch decision drains the scheduler: a marker written between two closes yields zero further `node-start`, in-flight nodes settle normally, `run-stopped` is journaled, the marker is consumed, unstarted nodes are `skipped`',
    evidence: 'test/loop/stop.test.ts',
    needs: ['tk.settle-aborted'],
    how: `LockSeam (src/loop/deps.ts) gains \`stopRequested(repoRoot, source): Promise<boolean>\` and \`clearStop(repoRoot, source): Promise<void>\`; the real seam (src/seams/lock.ts) keeps the marker at \`\${lockPath(repoRoot, source)}.stop\` (a file whose presence is the request); the in-memory harness lock implements both from a flag a test can flip. run-plan.ts scheduler: the launch condition becomes \`inflight.size < max && !aborted && !(await deps.lock.stopRequested(opts.repoRoot, plan.source))\` evaluated per launch decision (the same tick as the close that made a node ready), so a marker set at any moment yields no further launches; in-flight nodes are NOT interrupted; when the loop ends with the marker set, journal {event:'run-stopped'} (KINDS: run.lifecycle; docs/journal.md row) and clearStop; the unstarted nodes fall into \`skipped\` as today. Prove on the harness: a two-node chain where the test flips the flag inside the first node's settle (e.g. from a waitScript or a ledger emit) → exactly one node-start, run-stopped journaled, marker cleared, summary.skipped === [second]; and the no-marker case is byte-identical to today. ${GROUND}`,
  },
  {
    n: 4,
    id: 'tk.stop-face',
    claim:
      "`pleach stop <plan> [--repo-root] [--now]` writes the marker for the run's (repoRoot, source) beside its lock, refuses with exit 3 when no live run holds the lock, and with `--now` sends SIGINT to the lock's pid — proven against the real lock seam and a real process",
    evidence: 'test/integration/stop.test.ts',
    needs: ['tk.drain'],
    how: `A new verb in src/faces/cli.ts (help text: \`pleach stop <plan.json> [flags]  Drain a running plan: no new nodes launch, in-flight nodes settle; --now aborts them (SIGINT to the run)\`): read the plan (for plan.source), resolve --repo-root, and through the lock seam: if no LIVE pid holds lockPath(repoRoot, source) → stderr "no run holds the lock for <source>" and exit 3 (the LockHeldError family's code; add a typed error in core/errors.ts, e.g. NoRunError, mapped at the face); else requestStop (the seam writes the marker) and print what it did; with --now also process.kill(pid, 'SIGINT') via the seam (the face never signals by itself — add \`signalRun(repoRoot, source, 'SIGINT')\` to the seam so the loop/face stay process-free). Integration test against the real seam in a tmp repo: acquire a lock from a child process (a tiny bun script that acquires and sleeps), run the face → marker exists beside the lock; --now → the child receives SIGINT (it exits with a known code); no lock → exit 3 and no marker. ${GROUND}`,
  },
  {
    n: 5,
    id: 'tk.idle',
    claim:
      "The umbel adapter passes `--idle-timeout` from `Worker.wait`'s `idleMs`, threaded from a conductor default (`--idle-ms`, ten minutes); a worker that goes quiet returns `idle` from the real umbel binary and settles blocked with its tree quarantined",
    evidence: 'test/integration/umbel-idle.test.ts',
    needs: ['tk.stop-face'],
    how: `Worker.wait's opts (src/loop/deps.ts) gain \`idleMs?: number\` (additive; mirror the change in the informative "Seam interfaces" block of docs/contract/plan-schema.md — informative prose only, no schema-block change, so no drift-test or version change — and note it in docs/contract/CHANGES.md as doc-only). RunPlanOpts/RunNodeOpts gain idleMs; run-node passes it to every worker.wait (build and audit); src/faces/cli.ts adds \`--idle-ms N\` with default 600000 and documents it in the help; the umbel adapter appends \`--idle-timeout \${idleMs}ms\` when given. The existing idle → blocked mapping (gatherWorkerResult, classify) is unchanged. Prove with the real umbel binary and a fake worker that prints once and then stays silent (test/fixtures pattern): wait({timeoutMs: 60000, idleMs: 2000}) returns reason 'idle' within a few seconds, and through runPlan on that runner the node settles blocked with its tree quarantined; unit-assert the argv shape in test/unit/umbel-seam.test.ts. ${GROUND}`,
  },
  {
    n: 6,
    id: 'tk.docs',
    claim:
      'docs/journal.md documents `run-stopped`, the `aborted` verdict status and the `aborted` run-end field; `KINDS` pins `run-stopped`; the CLI help and README list `pleach stop` and `--idle-ms`',
    evidence: 'test/unit/journal-doc.test.ts',
    needs: ['tk.idle'],
    how: `The pin test already exists (test/unit/journal-doc.test.ts) and is RED the moment run-stopped is appended without its doc row or its KINDS entry — your RED phase is to make sure it is red (and extend it with one assertion if the earlier nodes already documented everything: e.g. that the verdict row's status list names 'aborted' and the run-end row names 'aborted'). Then: docs/journal.md rows/wording for run-stopped (run.lifecycle), the verdict row's status vocabulary (+aborted), the run-end row (+aborted); src/core/journal-envelope.ts KINDS['run-stopped'] = 'run.lifecycle' if a sibling has not; README.md's verb list and the CLI help block in src/faces/cli.ts mention \`pleach stop\` and \`--idle-ms\` (test/e2e/help.test.ts covers the help shapes — keep it green). ${GROUND}`,
  },
  {
    n: 7,
    id: 'tk.e2e',
    claim:
      "Through the real CLI: SIGINT mid-node leaves an `aborted` receipt, a `quarantine/<id>` holding the worker's files, `run-aborted` then `run-end`, exit 1; and `pleach stop` from a second process drains a two-node plan after the first close with `run-stopped` journaled and the marker gone",
    evidence: 'test/e2e/teardown.test.ts',
    needs: ['tk.docs'],
    timeoutMs: 2_700_000,
    how: `Model on test/e2e/quarantine.test.ts and test/e2e/cli.test.ts (real CLI, real git, the scripted runner in test/fixtures/*-scripted.config.ts — or a {command} node whose command sleeps, which needs no runner at all and is the cheapest way to hold a node in flight). (a) Start \`pleach run\` as a child process on a plan whose node writes a file then sleeps; once the file exists, send SIGINT to the child; assert exit 1, the receipt file for the node has facts.status 'aborted' and derived 'quarantined', \`quarantine/<id>\` exists and its tree holds the written file, the journal has run-aborted followed by run-end, and the summary JSON has aborted === [id]. (b) A two-node chain: start \`pleach run\`; when node/<first> appears (poll git), run \`pleach stop <plan>\` from a second process; assert the run exits 1 with summary.skipped === [second], closed === [first], run-stopped in the journal, and the marker file absent afterwards. This node is the sink of the loop: its audit verifies EVERY check on the page; if a sibling's check reads red here, fix it here and say so in Tried. ${GROUND}`,
  },
];

const spec: LoopSpec = {
  loop: 'docs/tend2/teardown-keeps-work.tend2.html',
  payload: '49cd299d549c',
  title: 'A halted run keeps the work it was holding',
  goal: "Stopping a run never loses a node's work. A node whose wait the run's own signal interrupts settles with Verdict.status 'aborted', a receipt, and its tree quarantined as it stands. `pleach stop <plan>` drains: the scheduler reads the stop marker in the same tick as every launch decision, launches nothing more, lets in-flight nodes settle normally and journals run-stopped; --now is the hard abort. A wedged worker ends at an idle timeout the conductor passes to the runner instead of riding to the attempt clock.",
  ledger: 'D16',
  sink: 'tk.e2e',
  checks,
};

export default spec;
