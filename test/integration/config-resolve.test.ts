// config-resolve integration test — uses real tmp git repos + fixture configs; no mocks.
import { expect, test } from 'bun:test';
import { ConfigError } from '../../src/core/errors.ts';
import { resolveSeams } from '../../src/faces/config.ts';
import { createRepo, makeBranch } from '../support/git-repo.ts';

// ── fixture paths ─────────────────────────────────────────────────────────────

const CUSTOM_CONFIG = new URL('../fixtures/pleach.config.custom.ts', import.meta.url).pathname;
const BAD_CONFIG = new URL('../fixtures/pleach.config.bad.ts', import.meta.url).pathname;

// ── tests ──────────────────────────────────────────────────────────────────────

// (a) custom config → custom ledger is used (sentinel key present in readClosed result)
test('resolveSeams: explicit config path → custom ledger selected (sentinel key present)', async () => {
  const repo = await createRepo();
  try {
    const { ledger } = await resolveSeams({
      config: CUSTOM_CONFIG,
      repoRoot: repo.path,
      rctrlBin: 'rctrl',
      permissionMode: 'bypassPermissions',
    });
    const closed = await ledger.readClosed('x');
    expect(closed.has('CUSTOM-SENTINEL')).toBe(true);
  } finally {
    await repo.cleanup();
  }
});

// (b) no config, no tendModule → gitLedger default, node/foo branch appears in readClosed
test('resolveSeams: no config → gitLedger default, node/foo branch is returned', async () => {
  const repo = await createRepo();
  try {
    await makeBranch(repo.path, 'node/foo');

    const { ledger } = await resolveSeams({
      repoRoot: repo.path,
      rctrlBin: 'rctrl',
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
        rctrlBin: 'rctrl',
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
        rctrlBin: 'rctrl',
        permissionMode: 'bypassPermissions',
      }),
    ).rejects.toThrow(ConfigError);
  } finally {
    await repo.cleanup();
  }
});
