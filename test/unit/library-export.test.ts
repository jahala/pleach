import { describe, expect, test } from 'bun:test';
import type { ConductorDeps, Plan, RunSummary } from 'pleach';
import { buildDeps, PlanInvalidError, planJsonSchema, runPlan, validatePlan } from 'pleach';

// Subject: pleach is importable as a library from the package root. The
// programmatic surface — run a plan in-process, assemble deps, validate, the
// typed errors, and the public types — is reachable without shelling out to
// the CLI. (The package '.' export points at the library barrel, not the CLI
// bootstrap, so importing the package never parses argv or calls process.exit.)

describe('library export — package root', () => {
  test('exposes the programmatic surface and public types', () => {
    expect(typeof runPlan).toBe('function');
    expect(typeof validatePlan).toBe('function');
    expect(typeof buildDeps).toBe('function');
    expect(typeof planJsonSchema).toBe('function');
    expect(PlanInvalidError).toBeDefined();

    // The public types resolve from the package root too.
    const plan: Plan = { goal: 'g', source: 's', nodes: [] };
    const summary: RunSummary = {
      closed: [],
      failed: [],
      partial: [],
      skipped: [],
      blocked: [],
      alreadyVerified: [],
    };
    expect(plan.nodes).toEqual([]);
    expect(summary.closed).toEqual([]);
  });

  test('buildDeps assembles a ConductorDeps from injected adapters', () => {
    // A trivial in-memory runner + ledger — buildDeps owns the four pleach seams
    // (exec/isolate/lock/journal) and takes the two adapters.
    const deps: ConductorDeps = buildDeps({
      repoRoot: '/tmp',
      runner: { spawnWorker: () => Promise.reject(new Error('unused')) },
      ledger: {
        readClosed: () => Promise.resolve(new Map()),
        emitVerdict: () => Promise.resolve({ closed: false }),
      },
    });
    expect(typeof deps.exec).toBe('function');
    expect(deps.isolate).toBeDefined();
    expect(deps.lock).toBeDefined();
    expect(deps.journal).toBeDefined();
    expect(deps.runner).toBeDefined();
    expect(deps.ledger).toBeDefined();
  });
});
