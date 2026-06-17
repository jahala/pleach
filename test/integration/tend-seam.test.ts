/**
 * Integration test for src/seams/tend.ts — createModuleTransport
 *
 * Runs against the REAL missoula ingester module (not a mock). Skipped unless:
 *   - PLEACH_TEND_MODULE env is set (explicit path), OR
 *   - the module path given in $PLEACH_TEND_MODULE exists
 *
 * Fixture construction mirrors missoula's own ingester.test.ts approach:
 *   - real tmp dir as project root
 *   - docs/tend/features/ directory structure
 *   - writeCatalog + writeFeature from missoula's files.js
 *
 * Tests:
 *   1. createModuleTransport rejects a path with missing exports (TendTransportError)
 *   2. readClosed via real module returns a Map (adapted from Set), verified feature present
 *   3. emitVerdict with status:'failed' Verdict → {closed:false}, no writes
 *
 * Round-trip (pass-verdict → verified) deferred to P6:
 *   The full round-trip requires importing missoula's writeFeature + writeCatalog to seed
 *   a feature with real check polyglots that the ingester's applyFeatureUpdate path can
 *   traverse. Those imports involve missoula's full garden model (vitest-based tests,
 *   feature polyglot format, catalog schema) — the machinery is importable in principle
 *   but requires resolving missoula's own module graph from a non-package path. The simpler
 *   path (file: dep or bun running its TS directly) is blocked until T1 lands as a
 *   published package. P6 will add the full round-trip once the transport is package-
 *   resolved; the deferred case is the verified-path test in the existing missoula
 *   ingester.test.ts which covers the same gate with real polyglots.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { createModuleTransport, createTendSeam } from '../../src/adapters/tend.ts';
import { TendTransportError } from '../../src/core/errors.ts';
import type { Verdict } from '../../src/core/plan.ts';

// ── Module path resolution ────────────────────────────────────────────────────

const TEND_MODULE = process.env.PLEACH_TEND_MODULE ?? '';

const MODULE_PATH = TEND_MODULE;
const MISSOULA_FILES = TEND_MODULE
  ? TEND_MODULE.replace('core/bridge/ingester.ts', 'core/files.js')
  : '';
async function moduleExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeFailedVerdict(node: string): Verdict {
  return {
    node,
    status: 'failed',
    output: null,
    evidence: { filesTouched: [] },
    telemetry: {},
    attempts: 1,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const shouldSkip = !(await moduleExists(MODULE_PATH));

describe.skipIf(shouldSkip)('createModuleTransport — real missoula ingester', () => {
  let root: string;

  beforeEach(async () => {
    // Create a minimal garden root. Mirrors makeProjectRoot in missoula's ingester.test.ts.
    const { mkdtemp, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    root = await mkdtemp(join(tmpdir(), 'pleach-tend-integ-'));
    await mkdir(join(root, 'docs', 'tend', 'features'), { recursive: true });
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });

  test('rejects a path with a missing export — throws TendTransportError', async () => {
    // A module that exists but exports nothing useful.
    // We create a temp file with no readClosed/emitVerdict exports.
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const tmpDir = await mkdtemp(join(tmpdir(), 'pleach-bad-module-'));
    const badPath = join(tmpDir, 'bad.ts');
    await writeFile(badPath, 'export const notATransport = 42;\n');
    try {
      await expect(createModuleTransport(badPath)).rejects.toBeInstanceOf(TendTransportError);
    } finally {
      const { rm } = await import('node:fs/promises');
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('rejects a non-existent path — throws TendTransportError', async () => {
    await expect(createModuleTransport('/nonexistent/path/ingester.ts')).rejects.toBeInstanceOf(
      TendTransportError,
    );
  });

  test('readClosed returns a Map (adapted), empty garden → empty Map', async () => {
    // Seed a minimal garden so readCatalog doesn't fail on missing files.
    // Mirror missoula's writeCatalog call with the bare minimum catalog.
    const missoula = (await import(MISSOULA_FILES)) as {
      writeCatalog: (catalog: unknown, root: string) => Promise<void>;
    };

    await missoula.writeCatalog(
      {
        schema_version: '1',
        project_id: 'test',
        status: 'draft',
        features: [],
      },
      root,
    );

    const transport = await createModuleTransport(MODULE_PATH);
    const seam = createTendSeam(transport);

    const result = await seam.readClosed(root);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test('readClosed returns a Map with verified feature present', async () => {
    const missoula = (await import(MISSOULA_FILES)) as {
      writeCatalog: (catalog: unknown, root: string) => Promise<void>;
      writeFeature: (feature: unknown, root: string) => Promise<void>;
    };

    // Seed catalog with one verified + one in-progress feature.
    await missoula.writeCatalog(
      {
        schema_version: '1',
        project_id: 'test',
        status: 'draft',
        features: [
          { id: 'feat-verified', title: 'Verified Feature', status: 'verified' },
          { id: 'feat-progress', title: 'In Progress', status: 'in-progress' },
        ],
      },
      root,
    );

    // Write feature polyglots so readFeature can locate them.
    await missoula.writeFeature(
      {
        id: 'feat-verified',
        title: 'Verified Feature',
        status: 'verified',
        what: 'a thing',
        checks: [],
      },
      root,
    );
    await missoula.writeFeature(
      {
        id: 'feat-progress',
        title: 'In Progress',
        status: 'in-progress',
        what: 'another thing',
        checks: [],
      },
      root,
    );

    const transport = await createModuleTransport(MODULE_PATH);
    const seam = createTendSeam(transport);

    const result = await seam.readClosed(root);

    expect(result).toBeInstanceOf(Map);
    // readClosed returns verified features; pre-T1 ingester returns Set → adapted to Map<id, null>
    expect(result.has('feat-verified')).toBe(true);
    // The SHA is null because the pre-T1 ingester returns Set (no SHA recorded)
    expect(result.get('feat-verified')).toBeNull();
    expect(result.has('feat-progress')).toBe(false);
  });

  test('emitVerdict with failed Verdict → {closed:false}, nothing written', async () => {
    const missoula = (await import(MISSOULA_FILES)) as {
      writeCatalog: (catalog: unknown, root: string) => Promise<void>;
      writeFeature: (feature: unknown, root: string) => Promise<void>;
      readFeature: (id: string, root: string) => Promise<{ audit?: unknown; status: string }>;
    };

    await missoula.writeCatalog(
      {
        schema_version: '1',
        project_id: 'test',
        status: 'draft',
        features: [{ id: 'feat-x', title: 'Feat X', status: 'in-progress' }],
      },
      root,
    );
    await missoula.writeFeature(
      {
        id: 'feat-x',
        title: 'Feat X',
        status: 'in-progress',
        what: 'a thing',
        checks: [
          { id: 'c1', description: 'check c1', validates: 'what', method: 'synthetic-test' },
        ],
      },
      root,
    );

    const transport = await createModuleTransport(MODULE_PATH);
    const seam = createTendSeam(transport);

    const v = makeFailedVerdict('feat-x');
    const result = await seam.emitVerdict(v, root);

    expect(result).toEqual({ closed: false });

    // Verify nothing was written to the feature.
    const after = await missoula.readFeature('feat-x', root);
    expect(after.audit).toBeUndefined();
    expect(after.status).toBe('in-progress');
  });
});
