// D18 §3 — `--land-gate CMD`: the operator names the gate the map needs. The
// sinks' own smokes have never seen this composition, and the question that
// caught weeder (are the garden's stamps on the evidence this landing moves
// still earned?) lives outside the plan entirely. So it is asked in pleach's
// own vocabulary: a command, repeatable, exec'd argv-style with no shell in
// the provisioned stack after the sinks' smokes, with `{base}` replaced by the
// target branch's tip as it was before the merges. A non-zero exit refuses the
// landing — `land-gate-refused` {command, exitCode, outputTail} on the journal,
// the stack disposed, the checkout untouched. pleach stays map-agnostic: it
// runs the command and reads the exit code.
//
// A map gate judges the landing as a whole, so it is never bisected — no sink
// can be the culprit for a question about the composition's context — and a
// non-zero exit is the answer, not a flake to retry.
//
// In-memory seams per the testing doctrine; the harness's landStack encodes
// the merged refs into the stack cwd, so what ran where is observable.
import { describe, expect, test } from 'bun:test';
import { LandBlockedError } from '../../src/core/errors.ts';
import { PlanSchema } from '../../src/core/plan.ts';
import { landPlan } from '../../src/loop/land.ts';
import { makeHarness } from './harness.ts';

const REPO = '/r';

function plan(nodes: { id: string; needs?: string[]; setup?: string; smoke?: string }[]) {
  return PlanSchema.parse({
    goal: 'land honestly',
    source: 'polyglot.html',
    nodes: nodes.map((n) => ({
      id: n.id,
      work: { command: `build-${n.id}` },
      needs: n.needs ?? [],
      ...(n.setup !== undefined ? { setup: n.setup } : {}),
      ...(n.smoke !== undefined ? { accept: { smoke: n.smoke } } : {}),
    })),
  });
}

// Verified ids close to `sha-<id>` and publish their node/<id> branch there;
// `main` is the branch the landing targets.
function closedHarness(
  ids: string[],
  execScript?: (argv: readonly string[], cwd: string) => { output: string; exitCode: number },
) {
  const closed = new Map(ids.map((id) => [id, `sha-${id}`]));
  const refs: Record<string, string> = { main: 'sha-main' };
  for (const id of ids) {
    refs[`node/${id}`] = `sha-${id}`;
    refs[`sha-${id}`] = `sha-${id}`;
  }
  return makeHarness({ closed, refs, ...(execScript ? { execScript } : {}) });
}

// What the stack itself says its base is — the seam owns that fact, so the
// substitution is asserted against the seam's answer, not a literal. Asked of
// a stack of its own so the landing under test keeps a clean log.
async function stackBaseSha(): Promise<string> {
  const probe = closedHarness(['a']);
  const stack = await probe.deps.isolate.landStack(REPO, ['node/a']);
  await stack.dispose();
  return stack.baseSha;
}

// Every command the gate worktree saw, in order (the stack cwd is `land:…`).
function stackRecorder(red?: { head: string; output: string; exitCode: number }) {
  const ran: string[][] = [];
  const script = (argv: readonly string[], cwd: string) => {
    if (!cwd.startsWith('land:')) return { output: '', exitCode: 0 };
    ran.push([...argv]);
    return argv[0] === red?.head
      ? { output: red.output, exitCode: red.exitCode }
      : { output: '', exitCode: 0 };
  };
  return { ran, script };
}

describe('landPlan --land-gate (D18)', () => {
  test('the named gates run in the stack after the sinks setup and smokes, in order', async () => {
    const p = plan([{ id: 'a', setup: 'install-a', smoke: 'test-a' }]);
    const { ran, script } = stackRecorder();
    const h = closedHarness(['a'], script);

    const summary = await landPlan(p, h.deps, {
      repoRoot: REPO,
      landGates: ['stamps --strict', 'links --check'],
    });

    // Repeatable: both gates run, in the order the operator gave them, and
    // only once the composition has satisfied every constituent's acceptance.
    expect(ran.map((argv) => argv.join(' '))).toEqual([
      'install-a',
      'test-a',
      'stamps --strict',
      'links --check',
    ]);
    expect(summary.landed).toEqual(['a']);
    expect(h.log.count('land')).toBe(1);
  });

  test('a gate runs on the provisioned stack even when no sink declares a smoke', async () => {
    // The map's question is about the landing, not about the sinks' tests —
    // a plan whose nodes carry no smoke must still be gated, and the stack it
    // is gated on must still be provisioned.
    const p = plan([{ id: 'a', setup: 'install-a' }]);
    const { ran, script } = stackRecorder();
    const h = closedHarness(['a'], script);

    const summary = await landPlan(p, h.deps, { repoRoot: REPO, landGates: ['stamps --strict'] });

    expect(ran.map((argv) => argv.join(' '))).toEqual(['install-a', 'stamps --strict']);
    expect(summary.landed).toEqual(['a']);
    expect(h.log.count('land')).toBe(1);
  });

  test('a non-zero exit refuses the landing: journaled, nothing published, stack disposed', async () => {
    const p = plan([
      { id: 'a', smoke: 'test-a' },
      { id: 'b', smoke: 'test-b' },
    ]);
    const { ran, script } = stackRecorder({
      head: 'stamps',
      output: '2 stale stamps: docs/tend2/a.tend2.html, docs/tend2/b.tend2.html',
      exitCode: 3,
    });
    const h = closedHarness(['a', 'b'], script);

    // One landing, examined — the counts below are about this landing alone.
    const refusal = await landPlan(p, h.deps, {
      repoRoot: REPO,
      landGates: ['stamps --strict', 'links --check'],
    }).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(LandBlockedError);
    expect((refusal as Error).message).toContain('stamps --strict');

    const refused = h.journal.find((e) => e.event === 'land-gate-refused');
    expect(refused?.command).toBe('stamps --strict');
    expect(refused?.exitCode).toBe(3);
    expect(refused?.outputTail).toBe(
      '2 stale stamps: docs/tend2/a.tend2.html, docs/tend2/b.tend2.html',
    );

    // Refused on the first red exit: the gate after it never runs, and the
    // red one is not retried (a map gate is an answer, not a flake).
    expect(ran.map((argv) => argv.join(' '))).toEqual(['test-a', 'test-b', 'stamps --strict']);
    // Nothing published, the checkout untouched, the stack cleaned up.
    expect(h.log.count('land')).toBe(0);
    expect(h.git.refs.get('main')).toBe('sha-main');
    expect(h.log.count('landStack-dispose')).toBe(1);
    // Never bisected: one stack built, no culprit named for a question that
    // was never about a single sink.
    expect(h.log.count('landStack')).toBe(1);
    expect(h.journal.find((e) => e.event === 'land-bisect')).toBeUndefined();
    expect(h.journal.find((e) => e.event === 'land-culprit')).toBeUndefined();
  });

  test('{base} is the target tip before the merges, everywhere it appears', async () => {
    const base = await stackBaseSha();
    const p = plan([{ id: 'a' }]);
    const { ran, script } = stackRecorder();
    const h = closedHarness(['a'], script);

    await landPlan(p, h.deps, {
      repoRoot: REPO,
      landGates: ['stamps docs/tend2 --base {base}', 'links --range={base}..HEAD'],
    });

    expect(ran[0]).toEqual(['stamps', 'docs/tend2', '--base', base]);
    expect(ran[1]).toEqual(['links', `--range=${base}..HEAD`]);
  });

  test('the journal records the command as it ran, with its output tail capped', async () => {
    const noise = 'x'.repeat(3000);
    const output = `${noise}\nstale: docs/tend2/a.tend2.html`;
    const base = await stackBaseSha();
    const p = plan([{ id: 'a' }]);
    const { script } = stackRecorder({ head: 'stamps', output, exitCode: 1 });
    const h = closedHarness(['a'], script);

    await expect(
      landPlan(p, h.deps, { repoRoot: REPO, landGates: ['stamps --base {base}'] }),
    ).rejects.toBeInstanceOf(LandBlockedError);

    const refused = h.journal.find((e) => e.event === 'land-gate-refused');
    // Substituted — the journal line is the operator's re-runnable evidence,
    // and `{base}` is not something anyone can re-run.
    expect(refused?.command).toBe(`stamps --base ${base}`);
    expect(refused?.outputTail).toBe(output.slice(-2000));
  });

  test('a gate with a bare shell operator is refused before anything runs', async () => {
    const p = plan([{ id: 'a', setup: 'install-a', smoke: 'test-a' }]);
    const ran: string[] = [];
    const h = closedHarness(['a'], (argv) => {
      ran.push(argv.join(' '));
      return { output: '', exitCode: 0 };
    });

    const landing = landPlan(p, h.deps, {
      repoRoot: REPO,
      landGates: ['stamps --strict', 'links --check && echo done'],
    });

    await expect(landing).rejects.toBeInstanceOf(LandBlockedError);
    // Unrunnable is knowable without running anything: no setup, no smoke, no
    // first gate, no merge to undo.
    expect(ran).toEqual([]);
    expect(h.log.count('land')).toBe(0);
    expect(h.git.refs.get('main')).toBe('sha-main');

    const refused = h.journal.find((e) => e.event === 'land-gate-refused');
    expect(refused?.command).toBe('links --check && echo done');
    expect(refused?.exitCode).toBe(-1);
    expect(String(refused?.outputTail)).toContain('bash -lc');
  });
});
