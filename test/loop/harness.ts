import {
  IsolateCatastrophicError,
  JournalRunMissingError,
  LockHeldError,
  type LockKind,
} from '../../src/core/errors.ts';
import type { Node, Verdict } from '../../src/core/plan.ts';
import { type Receipt, receiptPrefix } from '../../src/core/receipt.ts';
import type {
  ArtifactKind,
  ConductorDeps,
  ExecFn,
  IsolateSeam,
  Isolation,
  JournalSeam,
  LedgerSeam,
  LockHandle,
  LockSeam,
  ReceiptListing,
  RunnerSeam,
  Worker,
  WorkerResult,
} from '../../src/loop/deps.ts';

// ── in-memory seam harness ───────────────────────────────────────────────────
//
// Real, complete implementations of the deps.ts interfaces — a deterministic
// worker, an in-memory ledger, and an in-memory git. NOT mocks of the behaviour
// under test: the subject is the loop's scheduling/retry/close logic, and these
// seams are the world it composes. Everything funnels through one shared,
// ordered EventLog so tests can assert sequencing and concurrency invariants.

export interface Event {
  kind: string;
  node?: string;
  detail?: string;
  at: number; // monotonic sequence number
}

export class EventLog {
  readonly events: Event[] = [];
  private seq = 0;
  push(kind: string, node?: string, detail?: string): number {
    const at = this.seq++;
    this.events.push({ kind, node, detail, at });
    return at;
  }
  kinds(): string[] {
    return this.events.map((e) => e.kind);
  }
  of(kind: string): Event[] {
    return this.events.filter((e) => e.kind === kind);
  }
  // Sequence number of the first event matching kind (+optional node), or -1.
  first(kind: string, node?: string): number {
    const e = this.events.find(
      (ev) => ev.kind === kind && (node === undefined || ev.node === node),
    );
    return e ? e.at : -1;
  }
  last(kind: string, node?: string): number {
    let found = -1;
    for (const ev of this.events) {
      if (ev.kind === kind && (node === undefined || ev.node === node)) found = ev.at;
    }
    return found;
  }
  count(kind: string, node?: string): number {
    return this.events.filter((e) => e.kind === kind && (node === undefined || e.node === node))
      .length;
  }
}

// ── worker scripting ─────────────────────────────────────────────────────────
//
// A WorkerScript decides what each wait() returns. It is keyed by node id and a
// per-spawn index (a node may spawn several builders across attempts, and an
// auditor). The script callback receives the spawn context and the wait index.

export interface SpawnCtx {
  node: string;
  role: 'build' | 'audit';
  spawnIndex: number; // 0-based per (node, role)
}

export type WaitScript = (ctx: SpawnCtx, waitIndex: number) => WorkerResult | Promise<WorkerResult>;

export function stop(over: Partial<WorkerResult> = {}): WorkerResult {
  return { finalMessage: 'done', filesTouched: [], reason: 'stop', telemetry: {}, ...over };
}

// ── in-memory git ────────────────────────────────────────────────────────────

export class InMemoryGit {
  stagedDiffs = new Map<string, string>();
  stagedNumstats = new Map<string, { file: string; added: number; deleted: number }[]>();
  // branch/ref name → sha
  readonly refs = new Map<string, string>();
  // branch → last commit message (receipt-trailer assertions, §D), and every
  // commit under its own sha too — a detached phase seal (D13) has no branch.
  readonly commitMessages = new Map<string, string>();
  // sha → the --stat summary of what that commit introduced: the numstat of
  // the tree it was made from, rendered the way git renders one. A resumed
  // node's prompt is built from it (D17), so a commit this git made can be
  // described later without the tree it came from.
  readonly commitStats = new Map<string, string>();
  // worktree cwd → set of "changed" files the worker left behind
  readonly changed = new Map<string, string[]>();
  // worktree cwd → the paths its index holds against HEAD: what stage() was
  // handed that the tree actually changed (a named path with no change stages
  // nothing), emptied by a commit (D19).
  readonly index = new Map<string, string[]>();
  // worktree cwd → marker files present (conflict markers gate)
  readonly markers = new Map<string, string[]>();
  // worktree cwd → paths this tree's git ignores (the collection gate, D14)
  readonly ignored = new Map<string, string[]>();
  // worktree cwd → the files under .plotplot/friction/, path → contents. The
  // directory as it really is: month files beside the ledger's own state, so
  // the seam's read has something to choose between (D14).
  readonly friction = new Map<string, Record<string, string>>();
  private shaCounter = 0;

  // git's own shape: one line per file, then the totals.
  statOf(cwd: string): string | null {
    const numstat = this.stagedNumstats.get(cwd) ?? [];
    if (numstat.length === 0) return null;
    const files = numstat.map((n) => ` ${n.file} | ${n.added + n.deleted}`);
    const added = numstat.reduce((sum, n) => sum + n.added, 0);
    const deleted = numstat.reduce((sum, n) => sum + n.deleted, 0);
    const total = ` ${numstat.length} file(s) changed, ${added} insertion(s)(+), ${deleted} deletion(s)(-)`;
    return [...files, total].join('\n');
  }

  // A distinct 40-hex-char sha per commit — the padding used to swallow the
  // counter, so every commit in a run shared one sha and no test could tell two
  // commits apart (the red seal and the close, D13).
  newSha(): string {
    this.shaCounter += 1;
    return String(this.shaCounter).padStart(40, '0');
  }
}

// The branch this world lands on, and git's own answer for "there is no such
// commit" — a stack built in a world whose target branch has no tip yet.
const LAND_BRANCH = 'main';
const NO_COMMIT = '0'.repeat(40);

// ── receipt store naming ─────────────────────────────────────────────────────
//
// The real store (src/seams/receipts.ts) owns the directory and the filenames;
// the in-memory one mirrors both so a loop test reads the same paths the
// conductor journals. The real `<git-dir>` resolution is proven in e2e.
const RECEIPT_DIR = '/r/.git/pleach/receipts';
// The journal the in-memory one stands for, named in what it throws.
const JOURNAL_PATH = '/r/.git/pleach/journal.jsonl';
// Where the friction ledger writes inside a worktree (docs/plans/friction-ledger.md §5).
const FRICTION_DIR = '.plotplot/friction/';

// A month file of the journal: `<yyyy-mm>.jsonl` directly in that directory —
// not the ledger's `state/`, not its `hotspots.json`.
function isFrictionMonth(path: string): boolean {
  if (!path.startsWith(FRICTION_DIR) || !path.endsWith('.jsonl')) return false;
  return !path.slice(FRICTION_DIR.length).includes('/');
}
const ARTIFACT_SUFFIX: Record<ArtifactKind, string> = {
  sarif: '.sarif',
  friction: '.friction.jsonl',
  handback: '.handback.md',
};

// A close's own name in the store (D17): the node id, then its receipt's hash
// prefix. The un-prefixed name is whatever closed last.
function ownName(node: string, receiptSha256: string): string {
  return `${node}.${receiptPrefix(receiptSha256)}`;
}

// ── harness construction ─────────────────────────────────────────────────────

export interface HarnessOpts {
  // The provider name run-node uses for audit workers in the tests. A spawn
  // whose provider matches this is the auditor; everything else is a builder.
  // (Build retries reuse the build provider, so they stay 'build' even when
  // they re-spawn in the same reused tree — the cwd is NOT a reliable signal.)
  auditProvider?: string;
  // Worker wait behaviour. Default: a single stop with a passing audit block.
  waitScript?: WaitScript;
  // finalMessage for audit workers (the tend-audit-result egress). If a
  // function, called per audit spawn; lets tests vary egress across re-audits.
  auditEgress?: (ctx: SpawnCtx) => string;
  // exec results keyed by argv head; default exit 0 empty output. A script
  // naming only `output` models a child that wrote nothing to stderr, so the
  // interleaved stream IS its stdout; a script naming `stdout` too models one
  // whose stderr also spoke — `output` interleaved, `stdout` the child's own
  // stream, which is the only one a findings log can be read from (D14).
  execScript?: (
    argv: readonly string[],
    cwd: string,
  ) => { output: string; stdout?: string; exitCode: number };
  // pre-seeded refs (id/sha) — e.g. recorded SHAs for B1 reconciliation tests.
  refs?: Record<string, string>;
  // closed map tend returns from readClosed.
  closed?: Map<string, string | null>;
  // emitVerdict decision: returns {closed}. Default closes audit-done verdicts.
  emitDecision?: (v: Verdict) => { closed: boolean };
  // make isolate throw catastrophic for these baseRefs (bad-ref tests).
  badRefs?: Set<string>;
  // conflict files surfaced by isolate for a given node id.
  conflicts?: Record<string, string[]>;
  // changed files a worker leaves in its cwd, keyed by node id.
  changedByNode?: Record<string, string[]>;
  // Staged diff text per node id (the hygiene gate's raw material); numstat
  // defaults to one-added-line per changed file unless given.
  stagedDiffByNode?: Record<string, string>;
  stagedNumstatByNode?: Record<string, { file: string; added: number; deleted: number }[]>;
  // Branches checked out in another worktree: commitBranch and snapshot refuse
  // them like real git's guard ('used by worktree') — the #12
  // quarantine-collision seam.
  branchBusy?: (branch: string) => boolean;
  // The repository's pre-commit hook refusing the verified commit (D21): the
  // hook's output. commitBranch throws what the real seam throws when `git
  // commit` exits non-zero — the output inside the message; snapshot runs no
  // hook, so a quarantine still lands.
  commitBranchThrows?: string;
  // marker files left in cwd, keyed by node id (simulates auditor droppings).
  markersByNode?: Record<string, string[]>;
  // paths the node's tree ignores — the repo's .gitignore, as a fixture (D14).
  ignoredByNode?: Record<string, string[]>;
  // The worktree's `.plotplot/` contents, keyed by node id: worktree-relative
  // path → file contents. What weeder/tend2 wrote inside the tree while the
  // node ran; the seam reads the friction journal back out of it (D14).
  plotplotByNode?: Record<string, Record<string, string>>;
  // Awaited inside dispose(node) between 'dispose-start' and 'dispose' — lets a
  // test hold a worktree open to expose scheduling races.
  disposeDelay?: (nodeId: string) => Promise<void>;
  // Node ids whose dispose() throws IsolateCatastrophicError (fault injection).
  disposeThrows?: Set<string>;
  // Make the land stack's publish() throw (fault injection for landPlan's
  // journal paths — conflict/blocked refusal).
  landThrows?: Error;
  // Pre-seeded receipts keyed by node id (§D acceptance-evolution tests).
  receiptsSeed?: Record<string, Receipt>;
  // Make the receipt store's writeArtifact throw (fault injection for the
  // never-fail-a-close rule at settle, D14).
  writeArtifactThrows?: Error;
  // Make the receipt store's list() throw (fault injection for the run-start
  // gap check, which must never fail the run, D21).
  receiptsListThrows?: Error;
}

export interface Harness {
  deps: ConductorDeps;
  log: EventLog;
  git: InMemoryGit;
  emitted: Verdict[];
  journal: Record<string, unknown>[];
  receipts: Map<string, Receipt>;
  // Kept gate artifacts by the path the store returned (D14).
  artifacts: Map<string, string>;
  // Each run's copy of its own journal lines, by the path the store names (D21).
  runJournals: Map<string, string[]>;
  // The drain marker as the lock seam sees it (D16): set `requested` to write
  // one — before the run, or from inside a wait or a ledger emit to land it
  // mid-run; `cleared` counts the run's consumption of it.
  stop: { requested: boolean; cleared: number };
  // concurrency instrumentation
  maxConcurrentWorkers: number;
}

export function makeHarness(opts: HarnessOpts = {}): Harness {
  const log = new EventLog();
  const git = new InMemoryGit();
  const emitted: Verdict[] = [];
  const journalEvents: Record<string, unknown>[] = [];

  for (const [ref, sha] of Object.entries(opts.refs ?? {})) git.refs.set(ref, sha);

  const closedSource = opts.closed ?? new Map<string, string | null>();

  // Per-(node,role) spawn counters → SpawnCtx.spawnIndex.
  const spawnCounters = new Map<string, number>();
  // Per-worker wait index.
  let liveWorkers = 0;
  const state = { maxConcurrent: 0 };

  const defaultEgress = '```tend-audit-result\n{"verdicts":[{"check":"c","verdict":"pass"}]}\n```';

  const waitScript: WaitScript =
    opts.waitScript ??
    ((ctx) => (ctx.role === 'audit' ? stop({ finalMessage: auditEgressFor(ctx) }) : stop()));

  function auditEgressFor(ctx: SpawnCtx): string {
    return opts.auditEgress ? opts.auditEgress(ctx) : defaultEgress;
  }

  // ── exec ──────────────────────────────────────────────────────────────────
  const exec: ExecFn = async (argv, execOpts) => {
    log.push('exec', undefined, argv.join(' '));
    const r = opts.execScript ? opts.execScript(argv, execOpts.cwd) : { output: '', exitCode: 0 };
    return { output: r.output, stdout: r.stdout ?? r.output, exitCode: r.exitCode };
  };

  // ── isolate ─────────────────────────────────────────────────────────────────
  // Keep what is staged in `cwd` on `branch`: commitBranch and snapshot alike.
  function pointBranch(
    kind: 'commitBranch' | 'snapshot',
    cwd: string,
    branch: string,
    message: string,
  ): { sha: string } {
    if (opts.branchBusy?.(branch)) {
      log.push(`${kind}-busy`, branch);
      throw new Error(`cannot force update the branch '${branch}' used by worktree at /w`);
    }
    const sha = git.newSha();
    const stat = git.statOf(cwd);
    if (stat !== null) git.commitStats.set(sha, stat);
    git.refs.set(branch, sha);
    git.commitMessages.set(branch, message);
    git.commitMessages.set(sha, message);
    git.index.delete(cwd);
    log.push(kind, branch, sha);
    return { sha };
  }

  const isolate: IsolateSeam = {
    async isolate(node: Node, baseRefs): Promise<Isolation> {
      log.push('isolate', node.id, baseRefs.join(','));
      for (const ref of baseRefs) {
        if (opts.badRefs?.has(ref)) {
          throw new IsolateCatastrophicError(ref, 'bad ref (harness)');
        }
      }
      const cwd = `/wt/${node.id}/${log.count('isolate', node.id)}`;
      const conflictFiles = opts.conflicts?.[node.id] ?? [];
      // Workers produce something by default (a realistic tree — the hygiene
      // gate's empty-diff rule is doctrine now); pass an explicit [] to model
      // an agent that claims done on nothing.
      const produced = opts.changedByNode?.[node.id] ?? ['work.out'];
      if (produced.length > 0) {
        git.changed.set(cwd, [...produced]);
        git.stagedDiffs.set(cwd, opts.stagedDiffByNode?.[node.id] ?? '+++ b/work.out\n+ok\n');
        git.stagedNumstats.set(
          cwd,
          opts.stagedNumstatByNode?.[node.id] ??
            (opts.changedByNode?.[node.id] ?? []).map((f) => ({ file: f, added: 1, deleted: 0 })),
        );
      }
      if ((opts.markersByNode?.[node.id] ?? []).length > 0) {
        git.markers.set(cwd, [...(opts.markersByNode?.[node.id] ?? [])]);
      }
      if ((opts.ignoredByNode?.[node.id] ?? []).length > 0) {
        git.ignored.set(cwd, [...(opts.ignoredByNode?.[node.id] ?? [])]);
      }
      const plotplot = opts.plotplotByNode?.[node.id];
      if (plotplot !== undefined) git.friction.set(cwd, { ...plotplot });
      return {
        cwd,
        conflictFiles,
        async dispose() {
          log.push('dispose-start', node.id, cwd);
          if (opts.disposeDelay) await opts.disposeDelay(node.id);
          if (opts.disposeThrows?.has(node.id)) {
            throw new IsolateCatastrophicError(
              'git worktree remove',
              `dispose failed (harness): ${node.id}`,
            );
          }
          log.push('dispose', node.id, cwd);
        },
      };
    },
    async scanMarkers(cwd): Promise<string[]> {
      log.push('scanMarkers', undefined, cwd);
      return git.markers.get(cwd) ?? [];
    },
    // The tree's ignore rules, as a fixture: the same answer real git gives —
    // the caller's own paths, filtered to the ones this tree ignores (D14).
    async ignored(cwd, paths): Promise<string[]> {
      log.push('ignored', undefined, `${cwd}:${paths.join(',')}`);
      const rules = git.ignored.get(cwd) ?? [];
      return paths.filter((p) => rules.includes(p));
    },
    // The friction journal as the profile writes it: `<yyyy-mm>.jsonl` files
    // directly in `.plotplot/friction/`, concatenated in filename order — the
    // ledger's own `state/` and `hotspots.json` are not the journal. No
    // directory, or no month file in it, is an answer (null), not an error.
    async readFriction(cwd): Promise<string | null> {
      log.push('readFriction', undefined, cwd);
      const tree = git.friction.get(cwd) ?? {};
      const months = Object.keys(tree).filter(isFrictionMonth).sort();
      if (months.length === 0) return null;
      return months.map((p) => tree[p] ?? '').join('');
    },
    async stage(cwd, files): Promise<void> {
      log.push('stage', undefined, `${cwd}:${files.join(',')}`);
      const changed = git.changed.get(cwd) ?? [];
      const held = git.index.get(cwd) ?? [];
      const added = files.filter((f) => changed.includes(f) && !held.includes(f));
      git.index.set(cwd, [...held, ...added]);
    },
    async stagedPaths(cwd): Promise<string[]> {
      return [...(git.index.get(cwd) ?? [])];
    },
    async changedFiles(cwd): Promise<string[]> {
      log.push('changedFiles', undefined, cwd);
      return git.changed.get(cwd) ?? [];
    },
    async stagedDiff(cwd): Promise<string> {
      return git.stagedDiffs.get(cwd) ?? '';
    },
    async stagedNumstat(cwd) {
      return git.stagedNumstats.get(cwd) ?? [];
    },
    // The phase seal (D13): a commit on the detached HEAD — no branch moves,
    // so it is observable only through its sha, its message and the log order.
    async commit(cwd, message): Promise<{ sha: string }> {
      const sha = git.newSha();
      git.commitMessages.set(sha, message);
      const stat = git.statOf(cwd);
      if (stat !== null) git.commitStats.set(sha, stat);
      git.index.delete(cwd);
      log.push('commit', undefined, `${cwd}:${sha}`);
      return { sha };
    },
    async commitBranch(cwd, branch, message): Promise<{ sha: string }> {
      if (opts.commitBranchThrows !== undefined) {
        log.push('commitBranch-refused', branch);
        throw new IsolateCatastrophicError(
          `git commit --allow-empty -m ${message}`,
          `exited 1 in ${cwd}:\n${opts.commitBranchThrows}`,
        );
      }
      return pointBranch('commitBranch', cwd, branch, message);
    },
    // The quarantine (D21): the same branch move, logged apart so a test can
    // tell a snapshot from a commit. The in-memory git runs no hooks either way.
    async snapshot(cwd, branch, message): Promise<{ sha: string }> {
      return pointBranch('snapshot', cwd, branch, message);
    },
    async refSha(_cwd, ref): Promise<string | null> {
      return git.refs.get(ref) ?? null;
    },
    // What a commit this git made introduced: known for every commit it made,
    // and unknown — null, like a ref that does not resolve — for a sha a test
    // seeded into `refs` without a tree behind it.
    async commitStat(_cwd, ref): Promise<string | null> {
      return git.commitStats.get(ref) ?? git.commitStats.get(git.refs.get(ref) ?? '') ?? null;
    },
    async commitMessageOf(_cwd, ref): Promise<string | null> {
      for (const [branch, sha] of git.refs) {
        if (sha === ref || branch === ref) {
          const message = git.commitMessages.get(branch);
          if (message !== undefined) return message;
        }
      }
      return null;
    },
    // Staged landing (W1 of the adoption ladder): the loop gates the merged
    // stack between build and publish. The stack's cwd encodes the merged
    // refs so execScript-driven tests can simulate interaction failures.
    async landStack(_repoRoot, refs) {
      const cwd = `land:${refs.join('+')}`;
      log.push('landStack', undefined, cwd);
      return {
        cwd,
        // The landing target's tip before these merges (D18's `{base}`). This
        // world lands on 'main'; a world with no tip yet answers git's own
        // "there is no such commit".
        baseSha: git.refs.get(LAND_BRANCH) ?? NO_COMMIT,
        publish: async (): Promise<{ branch: string; sha: string }> => {
          log.push('land', undefined, refs.join(','));
          if (opts.landThrows) throw opts.landThrows;
          const sha = git.newSha();
          git.refs.set(LAND_BRANCH, sha);
          return { branch: LAND_BRANCH, sha };
        },
        dispose: async (): Promise<void> => {
          log.push('landStack-dispose', undefined, cwd);
        },
      };
    },
  };

  // ── umbel ─────────────────────────────────────────────────────────────────
  const auditProvider = opts.auditProvider ?? 'codex';
  const runner: RunnerSeam = {
    async spawnWorker(spec): Promise<Worker> {
      // Infer node from the cwd convention /wt/<node>/<n>; role by provider —
      // audit workers run a different provider (the diversity rule guarantees
      // it), so build retries in a reused tree stay 'build'.
      const m = /\/wt\/([^/]+)\//.exec(spec.cwd);
      const nodeId = m ? (m[1] as string) : 'unknown';
      const role: 'build' | 'audit' = spec.provider === auditProvider ? 'audit' : 'build';
      const roleKey = role === 'build' ? `${nodeId}:build` : `${nodeId}:audit`;
      const spawnIndex = spawnCounters.get(roleKey) ?? 0;
      spawnCounters.set(roleKey, spawnIndex + 1);
      const ctx: SpawnCtx = { node: nodeId, role, spawnIndex };

      liveWorkers += 1;
      if (liveWorkers > state.maxConcurrent) state.maxConcurrent = liveWorkers;
      log.push(`spawn:${role}`, nodeId, `concurrent=${liveWorkers}`);

      let waitIndex = 0;
      let alive = true;
      return {
        async send(text) {
          log.push('send', nodeId, `${role}:${text}`);
        },
        async wait(waitOpts?: { timeoutMs?: number; signal?: AbortSignal }) {
          // A real runner's wait ends promptly on abort (D12) — the harness
          // mirrors that contract so teardown is testable.
          const scripted = Promise.resolve(waitScript(ctx, waitIndex));
          const signal = waitOpts?.signal;
          const res =
            signal === undefined
              ? await scripted
              : await Promise.race([
                  scripted,
                  new Promise<WorkerResult>((resolve) => {
                    const aborted = () => resolve(stop({ reason: 'aborted' }));
                    if (signal.aborted) aborted();
                    else signal.addEventListener('abort', aborted, { once: true });
                  }),
                ]);
          waitIndex += 1;
          log.push('wait', nodeId, `${role}:${res.reason}`);
          return res;
        },
        async kill() {
          if (alive) {
            alive = false;
            liveWorkers -= 1;
            log.push('kill', nodeId, role);
          }
        },
      };
    },
  };

  // ── tend ────────────────────────────────────────────────────────────────────
  const ledger: LedgerSeam = {
    async readClosed(_source): Promise<Map<string, string | null>> {
      // Return the SAME map instance the test holds — exercises M3 (loop must
      // defensively copy; mutating this map post-start must not affect the run).
      return closedSource;
    },
    async emitVerdict(v): Promise<{ closed: boolean }> {
      emitted.push(structuredCloneVerdict(v));
      log.push('emitVerdict', v.node, v.status);
      if (opts.emitDecision) return opts.emitDecision(v);
      // default: close audit verdicts that are done; non-audit handled by loop.
      return { closed: v.status === 'done' };
    },
  };

  // ── lock ──────────────────────────────────────────────────────────────────
  //
  // The drain marker (D16) lives beside the lock because that is where the
  // (repoRoot, source) path is known. `pleach stop` writes a file; all the
  // scheduler ever asks is whether it is there, so in memory it is a flag a
  // test flips mid-run to land a marker between two closes — and `clearStop`
  // is the run consuming it.
  const stopMarker = { requested: false, cleared: 0 };
  // Two locks, each with its own flag (D18): the run's guards the run's state,
  // the landing's the base branch. A landing takes its own while a run holds
  // the run's, and only its own kind can refuse it.
  const held: Record<LockKind, boolean> = { run: false, land: false };
  function take(kind: LockKind, repoRoot: string, source: string): LockHandle {
    const path = `${repoRoot}/pleach-${source}.lock${kind === 'land' ? '.land' : ''}`;
    if (held[kind]) throw new LockHeldError(path, process.pid, kind);
    held[kind] = true;
    log.push('lock.acquire', undefined, kind);
    return {
      async release() {
        held[kind] = false;
        log.push('lock.release', undefined, kind);
      },
    };
  }
  const lockImpl = {
    async acquire(repoRoot: string, source: string): Promise<LockHandle> {
      return take('run', repoRoot, source);
    },

    async acquireLand(repoRoot: string, source: string): Promise<LockHandle> {
      return take('land', repoRoot, source);
    },
    async stopRequested(_repoRoot: string, _source: string): Promise<boolean> {
      log.push('lock.stopRequested', undefined, String(stopMarker.requested));
      return stopMarker.requested;
    },
    async clearStop(_repoRoot: string, _source: string): Promise<void> {
      stopMarker.requested = false;
      stopMarker.cleared += 1;
      log.push('lock.clearStop');
    },
  };
  const lock: LockSeam = lockImpl;

  // ── journal ─────────────────────────────────────────────────────────────────
  const journal: JournalSeam = {
    async append(event): Promise<void> {
      journalEvents.push(event);
    },
    async verdictNodes(): Promise<Set<string>> {
      const nodes = new Set<string>();
      for (const e of journalEvents) {
        if (e.event === 'verdict' && typeof e.node === 'string') nodes.add(e.node);
      }
      return nodes;
    },
    async linesSince(runId: string): Promise<string[]> {
      for (let i = journalEvents.length - 1; i >= 0; i--) {
        const e = journalEvents[i];
        if (e?.event === 'run-start' && e.runId === runId) {
          return journalEvents.slice(i).map((line) => JSON.stringify(line));
        }
      }
      throw new JournalRunMissingError(JOURNAL_PATH, runId);
    },
  };

  // ── receipts ────────────────────────────────────────────────────────────────
  const receiptsStore = new Map<string, Receipt>(Object.entries(opts.receiptsSeed ?? {}));
  // Every close under its own name too (D17) — the real store's second file,
  // keyed the way it names it.
  const closeStore = new Map<string, Receipt>();
  for (const [node, seeded] of receiptsStore) closeStore.set(ownName(node, seeded.sha256), seeded);
  // When each node's latest was written: the real store's file mtime (D21). A
  // receipt that never went through write() was there when the store was made.
  const storeMadeAt = new Date().toISOString();
  const writtenAt = new Map<string, string>();
  const artifactStore = new Map<string, string>();
  const runJournals = new Map<string, string[]>();
  const runJournalPath = (runId: string): string => `${RECEIPT_DIR}/runs/${runId}.journal.jsonl`;
  const receipts = {
    async writeArtifact(
      node: string,
      kind: ArtifactKind,
      bytes: string,
      receiptSha256: string,
    ): Promise<string> {
      if (opts.writeArtifactThrows) throw opts.writeArtifactThrows;
      const path = `${RECEIPT_DIR}/${ownName(node, receiptSha256)}${ARTIFACT_SUFFIX[kind]}`;
      artifactStore.set(path, bytes);
      artifactStore.set(`${RECEIPT_DIR}/${node}${ARTIFACT_SUFFIX[kind]}`, bytes);
      log.push('receipt.artifact', node, path);
      return path;
    },
    async discardArtifact(node: string, kind: ArtifactKind, receiptSha256: string): Promise<void> {
      const own = `${RECEIPT_DIR}/${ownName(node, receiptSha256)}${ARTIFACT_SUFFIX[kind]}`;
      // The name that mattered: the node's latest of this kind, which this
      // close must not be read as keeping. An earlier close's own file stays.
      const latest = `${RECEIPT_DIR}/${node}${ARTIFACT_SUFFIX[kind]}`;
      const forgotten = [artifactStore.delete(own), artifactStore.delete(latest)];
      if (forgotten.some(Boolean)) log.push('receipt.artifact-discard', node, latest);
    },
    async write(node: string, receipt: Receipt): Promise<void> {
      log.push('receipt.write', node, receipt.sha256);
      const kept = JSON.parse(JSON.stringify(receipt)) as Receipt;
      closeStore.set(ownName(node, receipt.sha256), kept);
      receiptsStore.set(node, kept);
      writtenAt.set(node, new Date().toISOString());
    },
    async list(): Promise<ReceiptListing[]> {
      if (opts.receiptsListThrows) throw opts.receiptsListThrows;
      return [...receiptsStore]
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        .map(([node, receipt]) => ({
          node,
          sha256: receipt.sha256,
          closedAt: writtenAt.get(node) ?? storeMadeAt,
        }));
    },
    async read(node: string): Promise<Receipt | null> {
      return receiptsStore.get(node) ?? null;
    },
    async readAt(node: string, receiptSha256: string): Promise<Receipt | null> {
      return closeStore.get(ownName(node, receiptSha256)) ?? null;
    },
    runJournalPath,
    async writeRunJournal(runId: string, lines: readonly string[]): Promise<void> {
      runJournals.set(runJournalPath(runId), [...lines]);
    },
  };

  const deps: ConductorDeps = { exec, isolate, runner, ledger, lock, journal, receipts };

  return {
    deps,
    log,
    git,
    emitted,
    journal: journalEvents,
    receipts: receiptsStore,
    artifacts: artifactStore,
    runJournals,
    stop: stopMarker,
    get maxConcurrentWorkers() {
      return state.maxConcurrent;
    },
  };
}

function structuredCloneVerdict(v: Verdict): Verdict {
  return JSON.parse(JSON.stringify(v)) as Verdict;
}

// ── node builder ─────────────────────────────────────────────────────────────

export function makeNode(over: Partial<Node> & { id: string }): Node {
  return {
    worker: {},
    work: { prompt: `build ${over.id}` },
    needs: [],
    accept: {},
    policy: { maxAttempts: 2, onDead: 'resume', reauditWhen: ['compacted'] },
    closes: [],
    ...over,
  } as Node;
}
