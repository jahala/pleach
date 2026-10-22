// ledger: D40
// issue #128 — a spawn that exits 126 means the provider needs a person to sign
// in before its CLI can work (umbel#105; plotplot contracts/runner.md pins 126
// as the code and class of the wait reason `input`). umbel refuses such a spawn
// and pleach must not meet the same screen twice: the node settles `blocked`
// after ONE spawn, with umbel's message and "sign in once, outside the
// conductor" as the next step. The run's `--fallback-provider` (D17) re-casts a
// 126 the way it re-casts a `dead` attempt, audit diversity re-checked; only
// when no usable fallback exists does the node settle blocked.
import { describe, expect, test } from 'bun:test';
import { WorkerSpawnError } from '../../src/core/errors.ts';
import { PlanSchema } from '../../src/core/plan.ts';
import type { RunSummary } from '../../src/loop/deps.ts';
import { runPlan } from '../../src/loop/run-plan.ts';
import { type Harness, makeHarness } from './harness.ts';

const OPTS = { repoRoot: '/r', pleachVersion: '0.0.1-test' };
const BUILD = 'claude';
const FALLBACK = 'opencode';
const AUDIT = 'codex';

// What umbel prints when its spawn is refused because the CLI opened on its
// sign-in screen — the text the verdict's blockedReason carries forward.
const REFUSAL_OUTPUT = 'Claude needs you to sign in before it can work';

function signInRefusal(): WorkerSpawnError {
  return new WorkerSpawnError(`umbel spawn exited 126: ${REFUSAL_OUTPUT}`, 126);
}

// The runner whose first spawn for `provider` is refused with a 126. Records who
// was cast (in spawn order) so the test can assert one spawn, not a retry.
function refuseSpawnOn(h: Harness, provider: string): (string | undefined)[] {
  const cast: (string | undefined)[] = [];
  const original = h.deps.runner.spawnWorker;
  h.deps.runner.spawnWorker = async (spec) => {
    cast.push(spec.provider);
    if (spec.provider === provider) throw signInRefusal();
    return original(spec);
  };
  return cast;
}

interface Shape {
  provider?: string;
  fallback?: string;
  audit?: string;
  maxAttempts?: number;
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
          accept:
            shape.audit !== undefined
              ? { audit: { command: 'bash git-audit.sh c3', provider: shape.audit } }
              : {},
          policy: { maxAttempts: shape.maxAttempts ?? 2, onDead: 'resume' },
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

describe('a spawn that exits 126 is a sign-in refusal (issue #128)', () => {
  test('the node settles blocked after ONE spawn, no retry, the reason naming sign-in', async () => {
    const h = makeHarness();
    const cast = refuseSpawnOn(h, BUILD);

    const summary = await run(h, { provider: BUILD, maxAttempts: 3 });

    expect(summary.blocked).toEqual(['x']);
    // One spawn, never a retry on the provider that needs a person.
    expect(cast).toEqual([BUILD]);
    expect(h.log.count('isolate', 'x')).toBe(1);

    const verdict = h.emitted.find((v) => v.node === 'x');
    expect(verdict?.status).toBe('blocked');
    expect(verdict?.attempts).toBe(1);
    expect(verdict?.evidence.blockedReason).toContain(REFUSAL_OUTPUT);
    expect(verdict?.evidence.blockedReason).toContain(
      'Sign in to claude once, outside the conductor, then re-run',
    );

    // The tree is kept for the operator, like every blocked node (D11).
    expect(h.git.refs.get('quarantine/x')).toBeDefined();
  });

  test('with a fallback provider the second spawn is the fallback and the node closes', async () => {
    const h = makeHarness();
    const cast = refuseSpawnOn(h, BUILD);

    const summary = await run(h, { provider: BUILD, fallback: FALLBACK, audit: AUDIT });

    expect(summary.closed).toEqual(['x']);
    // The primary refused once, the fallback built, the auditor was untouched —
    // the diversity rule held against the provider that actually ran.
    expect(cast).toEqual([BUILD, FALLBACK, AUDIT]);
    // Like a dead attempt: the refusal re-isolates on a fresh tree.
    expect(h.log.count('isolate', 'x')).toBe(2);
  });

  test('a fallback that is the auditor is refused and the node settles blocked', async () => {
    const h = makeHarness();
    const cast = refuseSpawnOn(h, BUILD);

    const summary = await run(h, { provider: BUILD, fallback: AUDIT, audit: AUDIT });

    expect(summary.blocked).toEqual(['x']);
    // Refused before the second cast, not after it.
    expect(cast).toEqual([BUILD]);
    expect(h.git.refs.get('quarantine/x')).toBeDefined();
  });

  test('a fallback that is the provider already refused is no fallback', async () => {
    const h = makeHarness();
    const cast = refuseSpawnOn(h, BUILD);

    const summary = await run(h, { provider: BUILD, fallback: BUILD });

    expect(summary.blocked).toEqual(['x']);
    expect(cast).toEqual([BUILD]);
  });
});
