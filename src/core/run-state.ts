// The fold that reads a run's state from the journal alone (issue #114).
//
// The journal is the only source of run state. Given the parsed lines, the
// plan's `source` and its node ids, this fold returns the state of the LATEST
// run of that source: whether it started and ended, its runId, and per node
// `{ status, attempts?, durationMs? }`. A node's status is `pending` (no
// node-start yet), `running` (node-start, no verdict), or the verdict's own
// status — `done` closes to `closed`, `done` declined by the ledger closes to
// `partial`, every other terminal verdict (failed/dead/timeout/rejected) reads
// `failed`, a node the run-end lists as already verified (a resumed run never
// rebuilds it) reads `verified`, and a node never started by the time the run
// ends reads `skipped`.
//
// Liveness is NOT decided here: whether a run whose start has no end is
// `running` or `interrupted` depends on the lock's live holder, which is I/O
// and lives in the face. This fold is pure and total — the clock, the
// filesystem and the process table are none of its business.

export type NodeStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'closed'
  | 'verified'
  | 'failed'
  | 'blocked'
  | 'partial'
  | 'aborted'
  | 'skipped';

export interface NodeRunState {
  status: NodeStatus;
  attempts?: number;
  durationMs?: number;
}

export interface RunState {
  started: boolean;
  ended: boolean;
  runId?: string;
  nodes: Record<string, NodeRunState>;
}

type Line = Record<string, unknown>;

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// A verdict's own status as a node status. `done` and `blocked` and `aborted`
// are the only verdicts that keep their own name; every other terminal verdict
// (failed, dead, timeout, rejected) is a failure to the node.
function verdictNodeStatus(status: string): NodeStatus {
  switch (status) {
    case 'done':
      return 'done';
    case 'blocked':
      return 'blocked';
    case 'aborted':
      return 'aborted';
    default:
      return 'failed';
  }
}

// A later lifecycle event (closed, not-closed) narrows the status but must not
// drop what the verdict recorded: a closed node's attempts and duration are
// still its story.
function narrow(nodes: Record<string, NodeRunState>, id: string, status: NodeStatus): void {
  const prev = nodes[id];
  nodes[id] = {
    status,
    ...(prev?.attempts !== undefined ? { attempts: prev.attempts } : {}),
    ...(prev?.durationMs !== undefined ? { durationMs: prev.durationMs } : {}),
  };
}

export function foldRunState(
  lines: readonly Line[],
  source: string,
  nodeIds: readonly string[],
): RunState {
  const ids = new Set(nodeIds);
  const nodes: Record<string, NodeRunState> = {};
  for (const id of nodeIds) nodes[id] = { status: 'pending' };

  // The latest run-start carrying this source. Runs of one source are
  // serialised by the lock, so the newest start is the run to report on.
  let startIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (
      line !== null &&
      line !== undefined &&
      line.event === 'run-start' &&
      line.source === source
    ) {
      startIndex = i;
      break;
    }
  }
  if (startIndex === -1) return { started: false, ended: false, nodes };

  const runId = asString(lines[startIndex]?.runId);

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === null || line === undefined || typeof line !== 'object') continue;
    const event = line.event;
    const node = asString(line.node);
    const inPlan = node !== undefined && ids.has(node);

    switch (event) {
      case 'node-start':
        if (inPlan) nodes[node as string] = { status: 'running' };
        break;
      case 'verdict':
        if (inPlan) {
          const attempts = asNumber(line.attempts);
          const durationMs = asNumber(line.durationMs);
          nodes[node as string] = {
            status: verdictNodeStatus(asString(line.status) ?? 'failed'),
            ...(attempts !== undefined ? { attempts } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
          };
        }
        break;
      case 'closed':
        if (inPlan) narrow(nodes, node as string, 'closed');
        break;
      case 'not-closed':
        if (inPlan) narrow(nodes, node as string, 'partial');
        break;
      case 'run-end': {
        // Whose end is it? A run-end names its runId, so one written by another
        // source's interleaved run is not mistaken for ours.
        if (runId === undefined || asString(line.runId) !== runId) break;
        const verified = new Set(
          Array.isArray(line.alreadyVerified)
            ? line.alreadyVerified.filter((v) => typeof v === 'string')
            : [],
        );
        for (const id of nodeIds) {
          if (verified.has(id)) nodes[id] = { status: 'verified' };
          else if (nodes[id]?.status === 'pending') nodes[id] = { status: 'skipped' };
        }
        return { started: true, ended: true, runId, nodes };
      }
      default:
        break;
    }
  }

  return { started: true, ended: false, runId, nodes };
}
