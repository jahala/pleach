import type { Check, LoopSpec } from '../make-plan.ts';

const GROUND = [
  "Ground truth, read before shaping: src/loop/land.ts landPlan(plan, deps, {repoRoot}) acquires deps.lock.acquire(repoRoot, plan.source) — the RUN's lock — then reads the ledger (readClosed), refuses unless EVERY plan node is verified (LandBlockedError, journal land-blocked {unverified}), collects the sinks (core/validate sinkIds), provisions the stack (collectSetupFor → provisionOrRefuse, D9), runs the composition gate (collectLandGate: the sinks' deduped smokes; runGate; on red: bisect → land-culprit / land-integrity-failed), and publishes ff-only through IsolateSeam.landStack(repoRoot, refs).publish(). The lock seam (src/seams/lock.ts) names locks <git-dir>/pleach-<sha1(source)[0:12]>.lock, exposes readPid/isAlive, stopPath (D16), requestStop, signalRun; LockHeldError(path, pid) is mapped to exit 3 at the face. Every plan-authored command is exec'd argv-style with no shell through guardedExec (src/loop/run-work.ts: toArgv + shellOperatorTokens refuse bare operators with the bash -lc escape hatch). Journal events are documented in docs/journal.md and pinned to src by test/unit/journal-doc.test.ts; every event needs a KINDS entry in src/core/journal-envelope.ts (land-* gate outcomes are 'gate.result', lifecycle is 'run.lifecycle'). The CLI (src/faces/cli.ts) parses flags in parseFlags; verbLand prints the landing JSON. tend2 is on this machine at /opt/homebrew/bin/tend2 (`tend2 gate <dir> --base REF [--runner ...]` re-verifies the stamps a change touches, exit non-zero on claimed-not-proven) but NOT in CI — pleach must never import or require it; the e2e uses a fixture gate script for CI and skipIf for the real tend2 case. The Plan schema (docs/contract/plan-schema.md) is untouched by this loop: no land section in the plan; the flags are the conductor's.",
].join(' ');

const checks: Check[] = [
  {
    n: 1,
    id: 'lh.land-lock',
    claim:
      "`landPlan` holds a land lock beside the run's, never the run's: a landing proceeds while a live run holds the run lock, two landings serialise on the land lock, and the refusal names the holder's pid and which lock — proven against the real lock seam and a real process",
    evidence: 'test/integration/land-lock.test.ts',
    needs: [],
    how: `LockSeam (src/loop/deps.ts) gains \`acquireLand(repoRoot, source): Promise<LockHandle>\` implemented in src/seams/lock.ts at \`\${lockPath}.land\` with the same O_EXCL pid + stale-takeover rules as acquire (share the helper; do not duplicate the ladder); the in-memory harness lock implements it from its own flag. landPlan uses acquireLand instead of acquire. LockHeldError gains (or its message carries) which lock it is — 'run' or 'land' — and the pid, so the face's exit-3 line reads "land lock held by pid N" / "run lock held by pid N". Prove against the real seam in a tmp repo with test/fixtures/hold-lock.ts (D16) holding the RUN lock from a child process: landPlan on a plan whose nodes are all verified in the ledger (use the in-memory ledger/isolate deps with the real lock seam, as test/integration/land.test.ts composes) proceeds; a second child holding the LAND lock makes it refuse with the pid and the word 'land'; a stale land lock (dead pid) is taken over. ${GROUND}`,
  },
  {
    n: 2,
    id: 'lh.sinks',
    claim:
      '`pleach land --sinks <id,…>` lands only the named verified sinks: a named node that is not verified is refused by name before any stack is built, the composition gate and publish cover only the subset, `land-start` journals `sinks`; without `--sinks` the all-or-nothing refusal is unchanged',
    evidence: 'test/loop/land-sinks.test.ts',
    needs: ['lh.land-lock'],
    how: `LandPlanOpts gains \`sinks?: string[]\`; src/faces/cli.ts parses \`--sinks a,b\` (comma-separated ids) for land. In landPlan: when sinks are named, every named id must be a plan node (PlanInvalidError-shaped refusal naming unknown ids) and verified-closed in the ledger (LandBlockedError naming the unverified ones, journal land-blocked {unverified}), and the landing proceeds with exactly those as its sinks — the stack, the setups, the smokes, the publish all over the subset; without --sinks, the existing every-node-verified rule and sinkIds() stand untouched. land-start gains \`sinks\` (the ids landed, subset or all). Prove on the in-memory harness (test/loop/land.test.ts is the model): a three-node plan with two verified → --sinks of the verified one lands it and journals sinks; --sinks naming the unverified one refuses by name with nothing built (no landStack call in the event log); no --sinks → today's refusal. ${GROUND}`,
  },
  {
    n: 3,
    id: 'lh.land-gate',
    claim:
      "`--land-gate CMD` (repeatable; `{base}` → the target tip's sha before the merge) runs argv-style in the provisioned stack after the sinks' smokes; a non-zero exit refuses the landing with `land-gate-refused` {command, exitCode, outputTail} journaled and printed, the stack disposed and the checkout untouched; a bare shell operator is refused before anything runs",
    evidence: 'test/loop/land-gate-command.test.ts',
    needs: ['lh.sinks'],
    how: `LandPlanOpts gains \`landGates?: string[]\`; the CLI collects repeated \`--land-gate CMD\`. In gateAndPublish, after the sinks' smokes pass on the stack and before publish: for each command, substitute the literal token \`{base}\` with the target branch's tip sha as it was before the merge (the stack knows it — expose it on LandStack, e.g. \`baseSha\`, from the isolate seam; the harness's landStack returns a fixed one), then guardedExec it in stack.cwd (the no-shell guard refuses a bare operator with the escape hatch named — that refusal is itself a land-gate-refused with exitCode -1, before any command runs); a non-zero exit journals {event:'land-gate-refused', command, exitCode, outputTail (capped 2000)} (KINDS: gate.result; docs/journal.md row), the CLI narrates it, the stack is disposed without publish, and landPlan throws LandBlockedError naming the command. Gates are NOT bisected — a map gate judges the landing as a whole, not one sink. Prove on the harness with execScript: a green gate publishes; a red gate refuses with the event and no publish; \`{base}\` reaches the argv as the base sha; a command with a bare \`&&\` is refused before exec. ${GROUND}`,
  },
  {
    n: 4,
    id: 'lh.docs',
    claim:
      "docs/journal.md documents `land-gate-refused` and `land-start`'s `sinks`; `KINDS` pins the event as `gate.result`; the CLI help and README list `--sinks` and `--land-gate`",
    evidence: 'test/unit/journal-doc.test.ts',
    needs: ['lh.land-gate'],
    how: `The pin test exists; extend it first with the assertion that makes it red (the land-start row names sinks; the help block names --sinks and --land-gate), then docs/journal.md (the land-gate-refused row if a sibling has not; land-start's fields), README's landing paragraph and flags, the help block in src/faces/cli.ts ("Flags (land)"); keep test/e2e/help.test.ts green. Document the runbook line the garden passes: \`--land-gate "tend2 gate docs/tend2 --base {base} --runner 'bun test {evidence}'"\`. ${GROUND}`,
  },
  {
    n: 5,
    id: 'lh.e2e',
    claim:
      "Through the real CLI with real git: a landing whose stack moves a stamped evidence file is refused by a `--land-gate` that runs tend2's gate (skipped honestly when the binary is absent) and by a fixture gate script that reads `{base}`; after the gate is green the same landing lands; and `pleach land --sinks` lands one verified node while a second process holds the run lock",
    evidence: 'test/e2e/land-honestly.test.ts',
    needs: ['lh.docs'],
    timeoutMs: 2_700_000,
    how: `Model on test/e2e/land.test.ts (run then land through the real CLI, {command} nodes need no runner). (a) A fixture gate script (test/fixtures/land-gate.sh) that takes the base sha as its argument, diffs base..HEAD in its cwd and exits 1 when a file named in a fixture "stamps" list changed: run a plan whose node rewrites that file, then \`pleach land --land-gate 'test/fixtures/land-gate.sh {base}'\` → exit 1, land-gate-refused in the journal with the tail, the target branch tip unmoved; then land with a gate that passes → landed. (b) test.skipIf(no tend2 on PATH): a tmp garden with one loop whose stamped check cites a file the node changes — \`tend2 verify\` to earn the stamp on the base first — then the same landing with \`--land-gate "/opt/homebrew/bin/tend2 gate <dir> --base {base} --runner 'bun test {evidence}'"\` is refused; re-earn the stamp on the stack's tree is out of scope — assert the refusal names the loop. (c) Hold the RUN lock from a child process (test/fixtures/hold-lock.ts) and \`pleach land --sinks <verified>\` lands it (exit 0). This node is the sink of the loop: its audit verifies EVERY check on the page; if a sibling's check reads red here, fix it here and say so in Tried. ${GROUND}`,
  },
];

const spec: LoopSpec = {
  loop: 'docs/tend2/land-honestly.tend2.html',
  payload: 'c9a4ddf3166d',
  title: 'Landing reads the map and does not wait on the whole run',
  goal: "A landing holds its own lock, so a settled node lands while the run is still gating others and the refusal names who holds what; `pleach land --sinks` lands a verified subset; and a land gate the operator names (--land-gate CMD, with {base} substituted) runs on the composed stack before publish, so a landing that would leave the garden's stamps stale is refused with the reason printed, never landed green.",
  ledger: 'D18',
  sink: 'lh.e2e',
  checks,
};

export default spec;
