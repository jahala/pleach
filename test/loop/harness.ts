import { IsolateCatastrophicError } from '../../src/core/errors.ts';
import type { Node, Verdict } from '../../src/core/plan.ts';
import type { Receipt } from '../../src/core/receipt.ts';
import type {
  ConductorDeps,
  ExecFn,
  ExecResult,
  IsolateSeam,
  Isolation,
  JournalSeam,
  LedgerSeam,
  LockHandle,
  LockSeam,
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
  // branch → last commit message (receipt-trailer assertions, §D)
  readonly commitMessages = new Map<string, string>();
  // worktree cwd → set of "changed" files the worker left behind
  readonly changed = new Map<string, string[]>();
  // worktree cwd → marker files present (conflict markers gate)
  readonly markers = new Map<string, string[]>();
  private shaCounter = 0;

  newSha(): string {
    this.shaCounter += 1;
    return `sha${String(this.shaCounter).padStart(40, '0')}`.slice(0, 40);
  }
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
  // exec results keyed by argv head; default exit 0 empty output.
  execScript?: (argv: readonly string[], cwd: string) => ExecResult;
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
  // Branches whose commitBranch refuses like real git's checked-out-branch
  // guard (exit 128 'used by worktree') — the #12 quarantine-collision seam.
  commitBranchBusy?: (branch: string) => boolean;
  // marker files left in cwd, keyed by node id (simulates auditor droppings).
  markersByNode?: Record<string, string[]>;
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
}

export interface Harness {
  deps: ConductorDeps;
  log: EventLog;
  git: InMemoryGit;
  emitted: Verdict[];
  journal: Record<string, unknown>[];
  receipts: Map<string, Receipt>;
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
    return r;
  };

  // ── isolate ─────────────────────────────────────────────────────────────────
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
    async stage(cwd, files): Promise<void> {
      log.push('stage', undefined, `${cwd}:${files.join(',')}`);
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
    async commitBranch(_cwd, branch, message): Promise<{ sha: string }> {
      if (opts.commitBranchBusy?.(branch)) {
        log.push('commitBranch-busy', branch);
        throw new Error(`cannot force update the branch '${branch}' used by worktree at /w`);
      }
      const sha = git.newSha();
      git.refs.set(branch, sha);
      git.commitMessages.set(branch, message);
      log.push('commitBranch', branch, sha);
      return { sha };
    },
    async refSha(_cwd, ref): Promise<string | null> {
      return git.refs.get(ref) ?? null;
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
        publish: async (): Promise<{ branch: string; sha: string }> => {
          log.push('land', undefined, refs.join(','));
          if (opts.landThrows) throw opts.landThrows;
          const sha = git.newSha();
          git.refs.set('main', sha);
          return { branch: 'main', sha };
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
  const lock: LockSeam = {
    async acquire(_repoRoot, _source): Promise<LockHandle> {
      log.push('lock.acquire');
      return {
        async release() {
          log.push('lock.release');
        },
      };
    },
  };

  // ── journal ─────────────────────────────────────────────────────────────────
  const journal: JournalSeam = {
    async append(event): Promise<void> {
      journalEvents.push(event);
    },
  };

  // ── receipts ────────────────────────────────────────────────────────────────
  const receiptsStore = new Map<string, Receipt>(Object.entries(opts.receiptsSeed ?? {}));
  const receipts = {
    async write(node: string, receipt: Receipt): Promise<void> {
      log.push('receipt.write', node, receipt.sha256);
      receiptsStore.set(node, JSON.parse(JSON.stringify(receipt)) as Receipt);
    },
    async read(node: string): Promise<Receipt | null> {
      return receiptsStore.get(node) ?? null;
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
