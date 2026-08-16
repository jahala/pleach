// config-resolve integration test — uses real tmp git repos + fixture configs; no mocks.
import { expect, test } from 'bun:test';
import { ConfigError } from '../../src/core/errors.ts';
import { resolveSeams } from '../../src/faces/config.ts';
import { createRepo, gitIn } from '../support/git-repo.ts';

// ── fixture paths ─────────────────────────────────────────────────────────────

const CUSTOM_CONFIG = new URL('../fixtures/pleach.config.custom.ts', import.meta.url).pathname;
const BAD_CONFIG = new URL('../fixtures/pleach.config.bad.ts', import.meta.url).pathname;
const EMPTY_SEAMS_CONFIG = new URL('../fixtures/pleach.config.empty-seams.ts', import.meta.url)
  .pathname;

// ── tests ──────────────────────────────────────────────────────────────────────

// (a) custom config → custom ledger is used (sentinel key present in readClosed result)
test('resolveSeams: explicit config path → custom ledger selected (sentinel key present)', async () => {
  const repo = await createRepo();
  try {
    const { ledger } = await resolveSeams({
      config: CUSTOM_CONFIG,
      repoRoot: repo.path,
      umbelBin: 'umbel',
      permissionMode: 'bypassPermissions',
    });
    const closed = await ledger.readClosed('x');
    expect(closed.has('CUSTOM-SENTINEL')).toBe(true);
  } finally {
    await repo.cleanup();
  }
});

// (b) no config, no tendModule → gitLedger default; a pleach-published branch
// for the queried source appears in readClosed (the ledger scopes by source).
test('resolveSeams: no config → gitLedger default, node/foo branch is returned', async () => {
  const repo = await createRepo();
  try {
    await gitIn(repo.path, 'checkout', '--detach', 'HEAD');
    await gitIn(
      repo.path,
      'commit',
      '--allow-empty',
      '-m',
      'pleach: foo verified (done)\n\nsource: x\ngoal: g',
    );
    await gitIn(repo.path, 'branch', '-f', 'node/foo', 'HEAD');

    const { ledger } = await resolveSeams({
      repoRoot: repo.path,
      umbelBin: 'umbel',
      permissionMode: 'bypassPermissions',
    });
    const closed = await ledger.readClosed('x');
    expect(closed.has('foo')).toBe(true);
  } finally {
    await repo.cleanup();
  }
});

// (c) config path points to a missing file → ConfigError
test('resolveSeams: missing config file → rejects with ConfigError', async () => {
  const repo = await createRepo();
  try {
    await expect(
      resolveSeams({
        config: '/no/such/pleach.config.ts',
        repoRoot: repo.path,
        umbelBin: 'umbel',
        permissionMode: 'bypassPermissions',
      }),
    ).rejects.toThrow(ConfigError);
  } finally {
    await repo.cleanup();
  }
});

// (d) config file exists but is invalid (missing ledger) → ConfigError
test('resolveSeams: invalid config (missing ledger) → rejects with ConfigError', async () => {
  const repo = await createRepo();
  try {
    await expect(
      resolveSeams({
        config: BAD_CONFIG,
        repoRoot: repo.path,
        umbelBin: 'umbel',
        permissionMode: 'bypassPermissions',
      }),
    ).rejects.toThrow(ConfigError);
  } finally {
    await repo.cleanup();
  }
});

// (e) config exports { runner: {}, ledger: {} } — shallow object check passes today,
// but the seams lack required methods; loadConfig must reject with ConfigError.
test('resolveSeams: config with empty-object seams → rejects with ConfigError (missing methods)', async () => {
  const repo = await createRepo();
  try {
    await expect(
      resolveSeams({
        config: EMPTY_SEAMS_CONFIG,
        repoRoot: repo.path,
        umbelBin: 'umbel',
        permissionMode: 'bypassPermissions',
      }),
    ).rejects.toThrow(ConfigError);
  } finally {
    await repo.cleanup();
  }
});
