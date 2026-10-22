# What pleach guarantees when things go wrong

A conductor is judged by its bad days. This is what happens to your work in each
one. Every behaviour here maps to an item in [`ledger.md`](ledger.md) and lands as
a failing test before its fix.

The short version: **work is never silently lost, and a verdict is never invented.**
A node that cannot finish keeps its tree on `quarantine/<id>` and writes a receipt.

## Landing

Landing is deterministic and fail-closed. It refuses unless every plan node is
verified, builds the merges in a throwaway worktree, and touches your checkout only
via a final fast-forward. A conflict aborts with the repo untouched.

It holds a lock of its own beside the run's, so it never queues behind gates it has
no stake in. Settled work lands while the run is still building the rest, two
landings serialise, and a refusal names the pid holding the lock and which lock it is.

`--sinks a,b` lands a named subset instead of the plan's own sinks. A node named
there that is not verified refuses the landing before anything is built.

`--land-gate CMD` runs on the composed stack after the sinks' smokes and before the
publish, argv-style with no shell. `{base}` is replaced by the target branch's tip
as it stood before the merges, so a gate can ask what this landing changes. That is
what makes a map's staleness check runnable at the one moment it matters. This repo's
own garden lands behind tend2's gate:

```sh
pleach land plan.json \
  --land-gate "tend2 gate docs/tend2 --base {base} --runner 'bun test {evidence}'"
```

A non-zero exit refuses the landing as `land-gate-refused`, with the command's output
tail on stderr and the repository untouched. Both flags shape `pleach run --land` too:
the landing a run performs is the same landing.

## An auditor's bad relay never costs the node

When the auditor's reply carries no readable result, or the auditor dies, the node is
quarantined with its build's gates green. `pleach audit plan.json <node>` re-adjudicates
it: the quarantined tree is checked out again with its dependencies merged as a run
merges them, setup provisions it, and only the audit runs.

A pass publishes `node/<id>`. Anything else writes a new quarantine receipt, and the
receipt of every close before it is still on file. It refuses a node whose latest close
is not a quarantine with a green smoke, because an audit verdict over an unproven build
proves nothing.

A re-audit is one question answered once: after a re-audit closes, asking `pleach audit`
again for the same `accept.audit.command` is refused (the command is unchanged). Change the
command and the re-audit is a different audit, so it runs. Every audit close records the
command it ran; a close from before that record existed has no command to compare, and the
next re-audit is allowed once — the close it writes then records the command.

## A provider outage is paid once

An attempt that comes back `dead` never got a working session, which is an outage rather
than a red gate. Re-running it on the same provider buys the same outage twice.

`--fallback-provider NAME` re-casts the node on another provider, with the cross-provider
audit's diversity rule re-checked against it. Without a usable fallback the node settles
after the one attempt with its remaining attempts unspent, and the verdict's `detail`
names why.

A provider error is different: the session worked, then the provider or the network failed
(a 5xx, a rate limit, a lost DNS lookup). The node waits and runs again inside the same
attempt, on the same tree, with the provider's words in the prompt: 15 s, then doubling, five
waits in all (`--provider-backoff-ms` sets the first). Only when the waits are spent does the
error cost an attempt, and the verdict's `detail` names the cause.

## A spawn that needs a person settles blocked

The runner refuses a worker whose provider CLI opens on its sign-in screen. umbel exits 126
(`contracts/runner.md` pins it as the code and class of the wait reason `input`), and pleach
settles the node `blocked` at once with umbel's message and "sign in to `<provider>` once,
outside the conductor, then re-run" as the next step. The tree is kept on `quarantine/<id>`.
It is never retried on that provider, because a retry meets the same sign-in screen.

`--fallback-provider` re-casts the refusal once, audit diversity re-checked, exactly as it
re-casts a `dead` attempt; only when no usable fallback exists does the node settle blocked.

## A worker's background work is waited for

A worker can end its turn while a command it started is still writing. Before any gate reads
the tree, pleach waits until the tree has not changed for one settle window (2 s;
`--settle-ms`, or `$PLEACH_SETTLE_MS`, where 0 turns it off). A tree still changing after
60 s fails the attempt under the `settle` gate, naming the paths, and the worker is asked to
finish or stop its background work.

## A fault in the plan is refused before a worker costs anything

pleach execs every command string argv-style with no shell. `pleach validate` refuses
(exit 2) a plan whose `work.command`, `work.test`, `setup` or `accept.smoke` holds a bare
shell operator such as `&&`, `|` or `>`, naming the node, the field, and the escape hatch:
`bash -lc '<command>'`. `pleach run` refuses the same plan before it takes the lock.

## A gate that cannot run fails its node once

A gate that cannot run is a fault of the plan or of the environment, never of the work, and
the node fails once either way. The no-shell guard's refusal is the plan's; a command the
environment cannot spawn (a missing binary, exit 127) is the environment's. The verdict's
`detail` names which, in the words the loop itself uses: `plan` when the plan's gate cannot
run, `environment` when the environment cannot run the gate. No further attempt is spent and
no worker is re-prompted. A gate that ran and failed is different: that still retries the
worker with its output.

## Halting a run never loses a node's work

`pleach stop plan.json` drains. The scheduler reads the stop marker in the same tick as
its next launch decision, so nothing further starts and the in-flight nodes settle normally.

`--now` adds the hard abort. An interrupted node settles `aborted`, its receipt written and
its worktree kept on `quarantine/<id>`, never counted as a failure.

A wedged worker never rides the attempt clock either: `--idle-ms` (default 10m) ends a wait
that has gone quiet, and the node settles blocked with its tree kept the same way.

## The next run picks that work up

A pending node whose `quarantine/<id>` still resolves is isolated from it. The quarantine is
the checkout base and its dependencies merge onto it as they always do. The worker's first
prompt names the sha it is resuming and what the tree holds.

A commit on top of the quarantine is kept. When the branch tip descends from the sha the
close recorded (`git merge-base --is-ancestor`), the resume stands on that tip — a
conductor's fix on the quarantined tree is part of the work, and the close records
`facts.base.moved` so it stays distinguishable. A branch that was reset to an unrelated
commit, or moved elsewhere, is ignored exactly as if it did not descend: the node builds from
its dependencies, and the journal says why.

Nothing about that tree is trusted. It was never gated, so the whole ladder runs over it,
from the marker scan through smoke and the cross-provider audit. The close records
`facts.base`, so a resumed close stays distinguishable from a fresh one forever.

`--fresh` refuses the seed and builds every pending node from its dependencies alone.

## A hook that refuses a verified commit keeps the work

The verified commit on `node/<id>` runs your repository's hooks, because a hook is the
repository's own gate. A refused commit is a gate verdict like any other: the node settles
`failed` under the `commit` gate, with the hook's output as the output tail in the journal
and hashed into the receipt. The tree is kept on `quarantine/<id>`, and that quarantine is a
snapshot (`write-tree`, `commit-tree`, `update-ref`), so no hook runs on it and no hook can
refuse it.

A hook may refuse the verified commit, but if it changes what the commit holds (a formatter
rewriting a file, or a hook staging one of its own), the commit is no longer the tree its gates
judged. pleach compares the two, and when a hook changes anything the node settles `failed`
under the `commit` gate, with the changed paths as the output tail. `node/<id>` never moves. The
tree is kept on `quarantine/<id>`, standing on the node's base, and the receipt is written. Run
a formatter as part of the node's work or its smoke, where the gates see its output.

## A seam's surprise keeps the work

The runner's reason is read from its output whatever its exit code, so a timeout, a provider
error or an idle worker settles the way the runner contract classifies it.

Anything else a seam throws mid-node settles the node `failed` under the gate `seam:<lane>`,
with the seam's text as the output tail and the attempt counted. The tree is kept on
`quarantine/<id>` and the receipt is written. The verdict's `detail` names the next step:
`pleach audit plan.json <node>` when only the audit threw, otherwise a re-run, which resumes
from the quarantine.

## A lost journal is reported

The journal at `<git-dir>/pleach/journal.jsonl` is one file, and the receipts beside it are
kept per close. Right after `run-start`, every node whose latest receipt has no `verdict` line
in the journal is journaled as `journal-gap`, so a journal that lost lines says so the next
time anyone runs. Right after `run-end`, the run's lines from its `run-start` through its
`run-end` are copied to `<git-dir>/pleach/receipts/runs/<runId>.journal.jsonl`, and the
`run-end` line names that file as `journalCopy`. The record can be rebuilt from what is kept
beside the receipts.

## A worker that writes BLOCKED.md has finished

A worker that cannot finish the plan in its tree writes `BLOCKED.md` at the tree's root: what
it tried, what stopped it, what a fix needs.

pleach reads that file when the attempt ends, before any gate runs, however the attempt ended:
a stop, a command that exits non-zero, a worker left at its prompt, or one out of time. Only a
provider that died or a run that halted keeps its own verdict.

The node settles `blocked` at once, with the file's text as the verdict's `blockedReason` and
the tree kept on `quarantine/<id>`, `BLOCKED.md` included. There is no retry, because a retry
would only ask the worker to explain again.

## Two operational facts

**Claude Code workers need the repo trusted.** Trust follows the main checkout
(`~/.claude.json`) rather than the worktree, and pleach's temporary worktrees inherit it. An
untrusted repo makes every worker hit the trust dialog.

**Hand-landing a quarantine is outside the ledger, by design.** If you review
`quarantine/<id>`, merge it yourself and verify it out-of-band, no `node/<id>` branch exists.
The map is the ledger, and the expected follow-up is re-emission; an emitter that drops
fully-stamped work, like tend2's, makes that a no-op. A gates-rerunning `land --from-quarantine`
verb is deliberately unbuilt until field use shows the manual path failing.
