/**
 * E2E: `pleach clean` reaps the worker sessions its journal names (issue #115).
 *
 * A real CLI run with a config file whose runner is a real, filesystem-backed
 * implementation of `reap`: a session "exists" while a file named after it is
 * present, and `reap` removes that file (killed) or reports it already gone.
 * The journal names two spawned sessions with no kill — one alive, one gone —
 * so clean kills the first, reports the second gone, and journals
 * `worker-reaped` for both. A second clean prints "nothing to clean";
 * `--dry-run` changes nothing; a live lock stops clean before any session.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepo } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function pleach(args: string[], env: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, stdout, stderr };
}

// The config's runner: reap is the filesystem-backed session store. It is a
// real implementation of the `reap` contract — presence decides, removal is
// the kill — never a mock of clean's own behaviour.
const CONFIG = `
import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';

const dir = process.env.PLEACH_TEST_SESSION_DIR ?? '';

export default {
  runner: {
    async spawnWorker() {
      throw new Error('spawnWorker is not used by clean');
    },
    async reap(session) {
      try {
        await access(join(dir, session));
      } catch {
        return 'gone';
      }
      await rm(join(dir, session), { force: true });
      return 'killed';
    },
  },
  ledger: {
    async readClosed() {
      return new Map();
    },
    async emitVerdict() {
      return { closed: true };
    },
  },
};
`;

describe('pleach clean — reaps the sessions its journal names (#115)', () => {
  let repo = '';
  let sessionDir = '';
  let configPath = '';
  let cleanup: () => Promise<void> = () => Promise.resolve();

  beforeEach(async () => {
    const r = await createRepo();
    repo = r.path;
    cleanup = r.cleanup;
    sessionDir = await mkdtemp(join(tmpdir(), 'pleach-clean-sessions-'));
    configPath = join(sessionDir, 'pleach.config.ts');
    await writeFile(configPath, CONFIG);
  });

  afterEach(async () => {
    await cleanup();
    await rm(sessionDir, { recursive: true, force: true });
  });

  async function journalPath(): Promise<string> {
    const gitDir = join(repo, '.git', 'pleach');
    await mkdir(gitDir, { recursive: true });
    return join(gitDir, 'journal.jsonl');
  }

  async function journalLines(): Promise<Record<string, unknown>[]> {
    try {
      const raw = await readFile(await journalPath(), 'utf8');
      return raw
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  test('kills the alive session, reports the gone one, journals both, then tidies', async () => {
    const alive = 'sess-alive';
    const gone = 'sess-gone';
    await appendFile(
      await journalPath(),
      `${JSON.stringify({ event: 'worker-spawned', node: 'a', session: alive })}\n` +
        `${JSON.stringify({ event: 'worker-spawned', node: 'b', session: gone })}\n`,
    );
    await writeFile(join(sessionDir, alive), 'x'); // alive
    // gone: no file — the session does not exist

    const first = await pleach(['clean', '--repo-root', repo, '--config', configPath], {
      PLEACH_TEST_SESSION_DIR: sessionDir,
    });

    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`killed worker session ${alive} (a)`);
    expect(first.stdout).toContain(`worker session ${gone} already gone (b)`);
    await expect(access(join(sessionDir, alive))).rejects.toThrow();

    const reaped = (await journalLines())
      .filter((l) => l.event === 'worker-reaped')
      .map((l) => ({ event: l.event, node: l.node, session: l.session, outcome: l.outcome }));
    expect(reaped).toEqual([
      { event: 'worker-reaped', node: 'a', session: alive, outcome: 'killed' },
      { event: 'worker-reaped', node: 'b', session: gone, outcome: 'gone' },
    ]);

    // A second clean sees nothing left to reap.
    const second = await pleach(['clean', '--repo-root', repo, '--config', configPath], {
      PLEACH_TEST_SESSION_DIR: sessionDir,
    });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('nothing to clean');
  });

  test('--dry-run lists the sessions and changes nothing', async () => {
    const alive = 'sess-alive';
    const gone = 'sess-gone';
    await appendFile(
      await journalPath(),
      `${JSON.stringify({ event: 'worker-spawned', node: 'a', session: alive })}\n` +
        `${JSON.stringify({ event: 'worker-spawned', node: 'b', session: gone })}\n`,
    );
    await writeFile(join(sessionDir, alive), 'x');

    const r = await pleach(['clean', '--dry-run', '--repo-root', repo, '--config', configPath], {
      PLEACH_TEST_SESSION_DIR: sessionDir,
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`would reap worker session ${alive} (a)`);
    expect(r.stdout).toContain(`would reap worker session ${gone} (b)`);
    // Changed nothing: the alive session still exists, no worker-reaped line.
    await access(join(sessionDir, alive)); // resolves — still there
    const reaped = (await journalLines()).filter((l) => l.event === 'worker-reaped');
    expect(reaped).toEqual([]);
  });

  test('a live lock stops clean before any session is touched', async () => {
    const alive = 'sess-alive';
    await appendFile(
      await journalPath(),
      `${JSON.stringify({ event: 'worker-spawned', node: 'a', session: alive })}\n`,
    );
    await writeFile(join(sessionDir, alive), 'x');
    await writeFile(join(repo, '.git', 'pleach-bbbbbbbbbbbb.lock'), String(process.pid));

    const r = await pleach(['clean', '--repo-root', repo, '--config', configPath], {
      PLEACH_TEST_SESSION_DIR: sessionDir,
    });

    expect(r.code).toBe(3);
    await access(join(sessionDir, alive)); // untouched
    const reaped = (await journalLines()).filter((l) => l.event === 'worker-reaped');
    expect(reaped).toEqual([]);
  });
});
