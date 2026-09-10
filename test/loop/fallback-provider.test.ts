// ledger: D17 — an outage is paid once. A worker that comes back `dead` said
// nothing about the work: it said the provider is gone (codex's 404, twice in
// one conducted week — jahala/pleach#65). Today's dead+resume spends the second
// attempt on the same dead provider, so the node pays two full timeouts to
// learn what the first one already proved.
//
// The run's `--fallback-provider` is the second cast. It is conductor-level —
// RunPlanOpts → RunNodeOpts, no plan field, no contract change — because who
// stands in for a dead provider is the operator's call for the run, not a fact
// about the node. It is re-checked against the audit diversity rule before it
// spawns: a fallback that equals `accept.audit.provider` would retire the
// cross-provider gate silently, which is the one thing this conductor exists
// to prevent. With no usable fallback the node settles after that one attempt
// and the journal says why. A red gate is the other thing entirely — the work
// can fix that, so smoke and timeout keep today's same-provider retry.
import { describe, expect, test } from 'bun:test';
import { PlanSchema } from '../../src/core/plan.ts';
import type { RunSummary, WorkerResult } from '../../src/loop/deps.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, type HarnessOpts, makeHarness, stop, type WaitScript } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };
const BUILD = 'claude'; // the cast the plan names
const FALLBACK = 'opencode'; // the run's second cast
const AUDIT = 'codex'; // the harness's auditor — the diversity rule's other side
const SMOKE = 'bun test';

// Why the node stopped after one dead attempt, on the verdict's journal line.
const SPENT = 'no fallback provider; the second attempt would have spent the same dead provider';

const AUDIT_PASS = '```tend-audit-result\n{"verdicts":[{"check":"c","verdict":"pass"}]}\n```';

// A provider that is gone: no session, so no message and no files — the runner
// names the end and nothing else.
function dead(): WorkerResult {
  return { reason: 'dead', finalMessage: '', filesTouched: [], telemetry: {} };
}

function timedOut(): WorkerResult {
  return { reason: 'timeout', finalMessage: '', filesTouched: [], telemetry: {} };
}

// The auditor always passes here — this loop is about who gets cast, not about
// what an audit found.
function script(build: (spawnIndex: number) => WorkerResult): WaitScript {
  return (ctx) =>
    ctx.role === 'audit' ? stop({ finalMessage: AUDIT_PASS }) : build(ctx.spawnIndex);
}

const diesOnce = script((i) => (i === 0 ? dead() : stop()));
const alwaysDies = script(() => dead());

interface Shape {
  // node.worker.provider; omitted leaves the plan silent, so the resolved
  // default is what a fallback has to be compared against.
  provider?: string;
  fallback?: string; // the run's --fallback-provider
  audit?: string; // accept.audit.provider
  smoke?: string;
  maxAttempts?: number;
  onDead?: 'resume' | 'fail';
}

async function run(h: Harness, shape: Shape): Promise<RunSummary> {
  return runPlan(
    PlanSchema.parse({
      goal: 'g',
      source: 'docs/tend2/nothing-is-lost.tend2.html',
      nodes: [
        {
          id: 'x',
          work: { prompt: 'build x' },
          ...(shape.provider !== undefined ? { worker: { provider: shape.provider } } : {}),
          accept: {
            ...(shape.smoke !== undefined ? { smoke: shape.smoke } : {}),
            ...(shape.audit !== undefined
              ? { audit: { command: 'bash git-audit.sh c3', provider: shape.audit } }
              : {}),
          },
          policy: { maxAttempts: shape.maxAttempts ?? 2, onDead: shape.onDead ?? 'resume' },
        },
      ],
    }),
    h.deps,
    {
      ...OPTS,
      ...(shape.fallback !== undefined ? { fallbackProvider: shape.fallback } : {}),
    },
  );
}

// Who was actually cast, in spawn order. The harness logs the role but not the
// provider, and the provider is the whole claim here.
function castings(h: Harness): (string | undefined)[] {
  const cast: (string | undefined)[] = [];
  const spawnWorker = h.deps.runner.spawnWorker;
  h.deps.runner.spawnWorker = (spec) => {
    cast.push(spec.provider);
    return spawnWorker(spec);
  };
  return cast;
}

function verdictLine(h: Harness): Record<string, unknown> {
  const lines = h.journal.filter((e) => e.event === 'verdict' && e.node === 'x');
  const line = lines[lines.length - 1];
  if (line === undefined) throw new Error('the settled node journaled no verdict');
  return line;
}

describe('a dead provider is paid once (D17)', () => {
  test('the dead attempt is re-cast on the fallback, in a fresh tree, and the node closes', async () => {
    const h = makeHarness({ waitScript: diesOnce });
    const cast = castings(h);

    const summary = await run(h, { provider: BUILD, fallback: FALLBACK, audit: AUDIT });

    expect(summary.closed).toEqual(['x']);
    // The second builder is the fallback, and the auditor is untouched by any
    // of it — the diversity rule held against the provider that actually ran.
    expect(cast).toEqual([BUILD, FALLBACK, AUDIT]);
    // dead+resume re-isolates: a provider that died left a tree nobody can
    // vouch for, and that is unchanged here.
    expect(h.log.count('isolate', 'x')).toBe(2);
    expect(h.log.count('spawn:build', 'x')).toBe(2);
  });

  test('the audit diversity rule is re-checked against the fallback, and refuses', async () => {
    // A fallback that is the auditor would leave one provider grading its own
    // work — the gate would still be "green", and mean nothing.
    const h = makeHarness({ waitScript: diesOnce });
    const cast = castings(h);

    const summary = await run(h, { provider: BUILD, fallback: AUDIT, audit: AUDIT });

    expect(summary.failed).toEqual(['x']);
    expect(cast).toEqual([BUILD]); // refused before the second cast, not after it

    const verdict = h.emitted.find((v) => v.node === 'x');
    expect(verdict?.status).toBe('failed');
    // Named the way the plan-time preflight names it: which two providers, and
    // that they must differ.
    const ran = verdict?.evidence.gate?.ran ?? '';
    expect(ran).toContain(AUDIT);
    expect(ran).toContain('must differ');

    // The refusal is a decision about the next attempt, not a reason to lose
    // the one that ran: the tree is still kept and the receipt still written.
    expect(h.git.refs.get('quarantine/x')).toBeDefined();
    expect(h.receipts.get('x')).toBeDefined();
  });

  test('with no fallback the node settles after one attempt, and the journal says why', async () => {
    // diesOnce, not alwaysDies: a second cast on the same provider would have
    // closed this node green, so nothing but the rule can produce this verdict.
    const h = makeHarness({ waitScript: diesOnce });
    const cast = castings(h);

    const summary = await run(h, { provider: BUILD, maxAttempts: 2 });

    expect(summary.failed).toEqual(['x']);
    expect(cast).toEqual([BUILD]);
    expect(h.log.count('spawn:build', 'x')).toBe(1);
    expect(h.log.count('isolate', 'x')).toBe(1);

    const verdict = h.emitted.find((v) => v.node === 'x');
    expect(verdict?.status).toBe('dead');
    expect(verdict?.attempts).toBe(1); // the outage cost one attempt, not two
    expect(verdict?.evidence.gate).toEqual({ ran: 'wait:dead', exitCode: -1 });

    // The operator reads the journal, not the source, to learn why an attempt
    // was left unspent.
    const line = verdictLine(h);
    expect(line.status).toBe('dead');
    expect(line.detail).toBe(SPENT);

    expect(h.git.refs.get('quarantine/x')).toBeDefined();
  });

  test('a fallback that is the provider already dead is no fallback', async () => {
    // The plan names no provider, so the comparison is against the resolved
    // default — a fallback of 'claude' here is the dead cast under another name.
    const h = makeHarness({ waitScript: diesOnce });
    const cast = castings(h);

    const summary = await run(h, { fallback: BUILD, maxAttempts: 2 });

    expect(summary.failed).toEqual(['x']);
    expect(cast).toHaveLength(1);
    expect(h.log.count('spawn:build', 'x')).toBe(1);

    const verdict = h.emitted.find((v) => v.node === 'x');
    expect(verdict?.status).toBe('dead');
    expect(verdict?.evidence.gate).toEqual({ ran: 'wait:dead', exitCode: -1 });
    expect(String(verdictLine(h).detail)).toContain('the same dead provider');
  });

  test('the fallback is spent once too — a dead second cast settles the node', async () => {
    const h = makeHarness({ waitScript: alwaysDies });
    const cast = castings(h);

    const summary = await run(h, { provider: BUILD, fallback: FALLBACK, maxAttempts: 3 });

    expect(summary.failed).toEqual(['x']);
    expect(cast).toEqual([BUILD, FALLBACK]); // the third attempt is never cast
    const verdict = h.emitted.find((v) => v.node === 'x');
    expect(verdict?.status).toBe('dead');
    expect(verdict?.attempts).toBe(2);
    expect(String(verdictLine(h).detail)).toContain('the same dead provider');
  });

  test("onDead: 'fail' keeps its policy — a fallback is not a licence to resume", async () => {
    const h = makeHarness({ waitScript: diesOnce });
    const cast = castings(h);

    const summary = await run(h, {
      provider: BUILD,
      fallback: FALLBACK,
      onDead: 'fail',
      maxAttempts: 2,
    });

    expect(summary.failed).toEqual(['x']);
    expect(cast).toEqual([BUILD]);
    expect(h.emitted.find((v) => v.node === 'x')?.status).toBe('dead');
  });
});

describe('a red gate keeps the cast (D17)', () => {
  // A failing smoke or an attempt that ran out of clock says something about
  // the work, not about the provider. Re-casting there would throw away the
  // tree and the context that the retry's evidence is for.
  function smokeRedOn(attempt: number, attemptNow: () => number): HarnessOpts['execScript'] {
    return (argv) =>
      argv.join(' ') === SMOKE
        ? { output: 'FAIL test/x.test.ts\n', exitCode: attemptNow() === attempt ? 1 : 0 }
        : { output: '', exitCode: 0 };
  }

  test('a smoke-red attempt retries on the same provider', async () => {
    let attempt = 0;
    const h = makeHarness({
      waitScript: script((i) => {
        attempt = i + 1;
        return stop();
      }),
      execScript: smokeRedOn(1, () => attempt),
    });
    const cast = castings(h);

    const summary = await run(h, {
      provider: BUILD,
      fallback: FALLBACK,
      smoke: SMOKE,
      maxAttempts: 2,
    });

    expect(summary.closed).toEqual(['x']);
    expect(cast).toEqual([BUILD, BUILD]);
    // And the retry reuses the tree the first attempt built — a red gate is
    // work in progress, not a lost provider.
    expect(h.log.count('isolate', 'x')).toBe(1);
  });

  test('a timed-out attempt retries on the same provider', async () => {
    const h = makeHarness({ waitScript: script((i) => (i === 0 ? timedOut() : stop())) });
    const cast = castings(h);

    const summary = await run(h, { provider: BUILD, fallback: FALLBACK, maxAttempts: 2 });

    expect(summary.closed).toEqual(['x']);
    expect(cast).toEqual([BUILD, BUILD]);
    expect(h.log.count('isolate', 'x')).toBe(1);
  });
});
