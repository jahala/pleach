/**
 * Integration: the receipt store keeps EVERY close (ledger D17). Real store in
 * a real repo's git dir, real git commits carrying the receipt trailers, the
 * real `pleach receipt` process — no mocks.
 *
 * A node id runs more than once (a retry, an acceptance-evolution re-dispatch,
 * a resumed quarantine). Until now the second close overwrote the first: one
 * `<node>.json`, one `<node>.sarif`, and the earlier close's facts gone. A
 * receipt is a record, not a slot — so every write also lands the close's own
 * `<node>.<sha256 prefix>.json`, artifacts take the same name, and
 * `pleach receipt <node>` verifies the latest and walks
 * `refs.previousReceiptSha256` back through the history it finds there.
 *
 * The prefix length is the store's business: these tests read whatever hex
 * segment the filename carries and hold it to the receipt's own hash.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { type MintFacts, mintReceipt, type Receipt } from '../../src/core/receipt.ts';
import type { ReceiptStore } from '../../src/loop/deps.ts';
import { verifyReceipt } from '../../src/loop/receipt-verify.ts';
import { exec } from '../../src/seams/exec.ts';
import { resolveGitDir } from '../../src/seams/gitdir.ts';
import { createIsolateSeam } from '../../src/seams/isolate.ts';
import { createReceiptStore } from '../../src/seams/receipts.ts';
import { createRepo, gitIn } from '../support/git-repo.ts';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const NODE = 'writer';

let repo = '';
let receiptDir = '';
let store: ReceiptStore;
let cleanup: () => Promise<void> = () => Promise.resolve();

beforeEach(async () => {
  const r = await createRepo();
  repo = r.path;
  cleanup = r.cleanup;
  receiptDir = join(resolveGitDir(repo), 'pleach', 'receipts');
  store = createReceiptStore(receiptDir);
});

afterEach(async () => {
  await cleanup();
});

function makeFacts(over: Partial<MintFacts> = {}): MintFacts {
  return {
    node: NODE,
    source: 'nothing-is-lost',
    status: 'done',
    attempts: 1,
    provider: 'claude',
    gates: [{ gate: 'smoke:bun test', exitCode: 0 }],
    acceptance: { smoke: 'bun test' },
    degraded: ['audit:unconfigured'],
    stagedFiles: 2,
    telemetry: {},
    durationMs: 1000,
    pleachVersion: '0.0.1-test',
    ...over,
  };
}

/** A real commit whose trailer pins the receipt, as settle's does. Returns its sha. */
async function commitWithTrailer(receipt: Receipt, subject: string): Promise<string> {
  await Bun.write(join(repo, `${subject}.txt`), `${subject}\n`);
  await gitIn(repo, 'add', '-A');
  await gitIn(repo, 'commit', '-m', `${subject}\n\nreceipt-sha256: ${receipt.sha256}`);
  return gitIn(repo, 'rev-parse', 'HEAD');
}

/** One close, written the way run-plan's settle writes it. */
async function close(
  facts: MintFacts,
  refs: (sha: string) => Receipt['refs'],
  previous?: Receipt,
): Promise<Receipt> {
  const minted = mintReceipt(facts);
  const sha = await commitWithTrailer(minted, `close-${minted.sha256.slice(0, 8)}`);
  const receipt: Receipt = {
    ...minted,
    refs: {
      ...refs(sha),
      ...(previous !== undefined ? { previousReceiptSha256: previous.sha256 } : {}),
    },
  };
  await store.write(NODE, receipt);
  return receipt;
}

/** The quarantined first close, then the clean second close of the same node id. */
async function twoCloses(): Promise<{ first: Receipt; second: Receipt }> {
  const first = await close(
    makeFacts({ status: 'failed', gates: [{ gate: 'smoke:bun test', exitCode: 1 }] }),
    (sha) => ({ quarantineBranch: `quarantine/${NODE}`, quarantineSha: sha }),
  );
  const second = await close(
    makeFacts({ attempts: 2, durationMs: 2000 }),
    (sha) => ({ diffRef: sha }),
    first,
  );
  return { first, second };
}

/** Every `<node>.<hex>.<ext>` in the store, keyed by the hex segment. */
async function historyFiles(ext: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of await readdir(receiptDir)) {
    const match = name.match(new RegExp(`^${NODE}\\.([0-9a-f]+)\\.${ext}$`));
    if (match?.[1] !== undefined) out.set(match[1], await readFile(join(receiptDir, name), 'utf8'));
  }
  return out;
}

/** The one history entry for `receipt`, proving the filename is its own hash. */
function historyOf(files: Map<string, string>, receipt: Receipt): string {
  const entries = [...files].filter(([prefix]) => receipt.sha256.startsWith(prefix));
  expect(entries.length).toBe(1);
  return entries[0]?.[1] ?? '';
}

/** The hex segment of a `<node>.<hex>.json` history filename. */
function segment(filename: string): string {
  return filename.match(new RegExp(`^${NODE}\\.([0-9a-f]+)\\.json$`))?.[1] ?? 'no-match';
}

async function pleach(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: repo,
    env: process.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code ?? 1, stdout, stderr };
}

// ledger: D17
test('every close keeps its own receipt file; <node>.json is the latest', async () => {
  const { first, second } = await twoCloses();

  const files = await historyFiles('json');
  expect(files.size).toBe(2);
  expect(JSON.parse(historyOf(files, first)) as Receipt).toEqual(first);
  expect(JSON.parse(historyOf(files, second)) as Receipt).toEqual(second);

  const latest = JSON.parse(await readFile(join(receiptDir, `${NODE}.json`), 'utf8')) as Receipt;
  expect(latest).toEqual(second);
  expect(await store.read(NODE)).toEqual(second);
});

// ledger: D17
test("an artifact belongs to its close — a later close never becomes the earlier one's log", async () => {
  const first = await close(
    makeFacts({ status: 'failed', gates: [{ gate: 'smoke:bun test', exitCode: 1 }] }),
    (sha) => ({ quarantineBranch: `quarantine/${NODE}`, quarantineSha: sha }),
  );
  const firstPath = await store.writeArtifact(NODE, 'sarif', '{"runs":["first"]}', first.sha256);
  const firstHandback = await store.writeArtifact(
    NODE,
    'handback',
    'handed back once',
    first.sha256,
  );

  const second = await close(makeFacts({ attempts: 2 }), (sha) => ({ diffRef: sha }), first);
  const secondPath = await store.writeArtifact(NODE, 'sarif', '{"runs":["second"]}', second.sha256);

  expect(firstPath).not.toBe(secondPath);
  expect(await readFile(firstPath, 'utf8')).toBe('{"runs":["first"]}');
  expect(await readFile(secondPath, 'utf8')).toBe('{"runs":["second"]}');
  // The un-prefixed name stays the latest close's, as the receipt file names it.
  expect(await readFile(join(receiptDir, `${NODE}.sarif`), 'utf8')).toBe('{"runs":["second"]}');
  expect(await readFile(firstHandback, 'utf8')).toBe('handed back once');

  const sarifs = await historyFiles('sarif');
  expect(sarifs.size).toBe(2);
  expect(historyOf(sarifs, first)).toBe('{"runs":["first"]}');
  expect(historyOf(sarifs, second)).toBe('{"runs":["second"]}');

  // A third close keeps nothing: the latest name must not answer with the
  // second close's log — and the earlier closes' own logs are not its to drop.
  const third = await close(makeFacts({ attempts: 3 }), (sha) => ({ diffRef: sha }), second);
  await store.discardArtifact(NODE, 'sarif', third.sha256);
  await expect(readFile(join(receiptDir, `${NODE}.sarif`), 'utf8')).rejects.toThrow();
  expect(await readFile(firstPath, 'utf8')).toBe('{"runs":["first"]}');
  expect(await readFile(secondPath, 'utf8')).toBe('{"runs":["second"]}');
});

// ledger: D17
test('verifyReceipt verifies the latest and lists the prior closes', async () => {
  const { first, second } = await twoCloses();
  const deps = { isolate: createIsolateSeam(exec, repo), receipts: store };

  const check = await verifyReceipt(NODE, deps, repo);
  expect(check.outcome).toBe('pass');
  expect(check.receipt?.sha256).toBe(second.sha256);
  expect(check.history).toEqual([
    { sha256: first.sha256, status: 'failed', derived: 'quarantined' },
  ]);
});

// ledger: D17
test('a single close has no history to walk', async () => {
  const only = await close(makeFacts(), (sha) => ({ diffRef: sha }));
  const deps = { isolate: createIsolateSeam(exec, repo), receipts: store };

  const check = await verifyReceipt(NODE, deps, repo);
  expect(check.outcome).toBe('pass');
  expect(check.receipt?.sha256).toBe(only.sha256);
  expect(check.history).toEqual([]);
});

// ledger: D17
test('a history file that is gone is reported, never silently dropped', async () => {
  const { first } = await twoCloses();
  const files = await readdir(receiptDir);
  const lost = files.find((n) => n !== `${NODE}.json` && first.sha256.startsWith(segment(n)));
  expect(lost).toBeDefined();
  await unlink(join(receiptDir, lost ?? ''));

  const deps = { isolate: createIsolateSeam(exec, repo), receipts: store };
  const check = await verifyReceipt(NODE, deps, repo);
  expect(check.outcome).toBe('pass');
  expect(check.history).toEqual([{ sha256: first.sha256, missing: true }]);
});

// ledger: D17
test('`pleach receipt <node>` prints one line per prior close', async () => {
  const { first, second } = await twoCloses();

  const res = await pleach(['receipt', NODE, '--repo-root', repo]);
  expect(res.code).toBe(0);

  const json = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
  expect(json.outcome).toBe('pass');
  expect(json.sha256).toBe(second.sha256);
  expect(json.history).toEqual([
    { sha256: first.sha256, status: 'failed', derived: 'quarantined' },
  ]);

  const line = res.stderr
    .split('\n')
    .find((l) => l.includes('failed') && l.includes('quarantined'));
  expect(line).toBeDefined();
  const shown = line?.match(/[0-9a-f]{8,}/)?.[0] ?? '';
  expect(first.sha256.startsWith(shown)).toBe(true);
}, 30_000);
