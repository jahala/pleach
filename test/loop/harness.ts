import { IsolateCatastrophicError } from '../../src/core/errors.ts';
import type { Node, Verdict } from '../../src/core/plan.ts';
import type {
  ConductorDeps,
  ExecFn,
  ExecResult,
  Isolation,
  IsolateSeam,
  JournalSeam,
  LockHandle,
  LockSeam,
  RctrlSeam,
  TendSeam,
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
    const e = this.events.find((ev) => ev.kind === kind && (node === undefined || ev.node === node));
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

export type WaitScript = (ctx: SpawnCtx, waitIndex: number) => WorkerResult;

export function stop(over: Partial<WorkerResult> = {}): WorkerResult {
  return { finalMessage: 'done', filesTouched: [], reason: 'stop', telemetry: {}, ...over };
}

// ── in-memory git ────────────────────────────────────────────────────────────

export class InMemoryGit {
  // branch/ref name → sha
  readonly refs = new Map<string, string>();
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
  // marker files left in cwd, keyed by node id (simulates auditor droppings).
  markersByNode?: Record<string, string[]>;
}

export interface Harness {
  deps: ConductorDeps;
  log: EventLog;
  git: InMemoryGit;
  emitted: Verdict[];
  journal: Record<string, unknown>[];
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
    const r = opts.execScript
      ? opts.execScript(argv, execOpts.cwd)
      : { output: '', exitCode: 0 };
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
      if ((opts.changedByNode?.[node.id] ?? []).length > 0) {
        git.changed.set(cwd, [...(opts.changedByNode?.[node.id] ?? [])]);
      }
      if ((opts.markersByNode?.[node.id] ?? []).length > 0) {
        git.markers.set(cwd, [...(opts.markersByNode?.[node.id] ?? [])]);
      }
      return {
        cwd,
        conflictFiles,
        async dispose() {
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
    async commitBranch(cwd, branch, _message): Promise<{ sha: string }> {
      const sha = git.newSha();
      git.refs.set(branch, sha);
      log.push('commitBranch', branch, sha);
      return { sha };
    },
    async refSha(_cwd, ref): Promise<string | null> {
      return git.refs.get(ref) ?? null;
    },
  };

  // ── rctrl ─────────────────────────────────────────────────────────────────
  const auditProvider = opts.auditProvider ?? 'codex';
  const rctrl: RctrlSeam = {
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
        async wait() {
          const res = waitScript(ctx, waitIndex);
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
  const tend: TendSeam = {
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

  const deps: ConductorDeps = { exec, isolate, rctrl, tend, lock, journal };

  return {
    deps,
    log,
    git,
    emitted,
    journal: journalEvents,
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
