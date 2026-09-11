// Integration: the two reads behind the run-start gap check (ledger D21), on
// the real receipt store and the real journal file — no mocks. The loop's use
// of them is proven in test/loop/journal-gap.test.ts.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintReceipt, type Receipt } from '../../src/core/receipt.ts';
import { createJournal } from '../../src/seams/journal.ts';
import { createReceiptStore } from '../../src/seams/receipts.ts';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pleach-journal-gap-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function receiptFor(node: string, attempts: number): Receipt {
  return mintReceipt({
    node,
    source: 's',
    status: 'done',
    attempts,
    provider: 'claude',
    gates: [],
    acceptance: {},
    degraded: [],
    stagedFiles: 1,
    telemetry: {},
    durationMs: 1,
    pleachVersion: '0.0.1-test',
  });
}

describe('ReceiptStore.list (D21)', () => {
  // ledger: D21
  test("lists each node's latest close once, and a dotted id is its own node", async () => {
    const store = createReceiptStore(join(dir, 'receipts'));
    const first = receiptFor('a', 1);
    const second = receiptFor('a', 2);
    const dotted = receiptFor('a.b', 1);
    await store.write('a', first);
    await store.write('a', second);
    await store.write('a.b', dotted);
    await store.writeArtifact('a', 'handback', 'done\n', second.sha256);

    const listed = await store.list();

    expect(listed.map(({ node, sha256 }) => ({ node, sha256 }))).toEqual([
      { node: 'a', sha256: second.sha256 },
      { node: 'a.b', sha256: dotted.sha256 },
    ]);
    for (const { closedAt } of listed) {
      expect(new Date(closedAt).toISOString()).toBe(closedAt);
    }
  });

  // ledger: D21
  test('a store nothing has closed in lists nothing', async () => {
    expect(await createReceiptStore(join(dir, 'receipts')).list()).toEqual([]);
  });
});

describe('JournalSeam.verdictNodes (D21)', () => {
  // ledger: D21
  test('names the nodes with a verdict line, reading past a torn one', async () => {
    const path = join(dir, 'journal.jsonl');
    const journal = createJournal(path);
    await journal.append({ event: 'run-start', goal: 'g', nodes: 3 });
    await journal.append({ event: 'verdict', node: 'x', status: 'failed', attempts: 1 });
    await journal.append({ event: 'receipt', node: 'y', sha256: 'f'.repeat(64) });
    await appendFile(path, '{"event":"verdict","node":"t', 'utf8');
    await appendFile(path, '\n', 'utf8');
    await journal.append({ event: 'verdict', node: 'z', status: 'done', attempts: 1 });

    expect(await journal.verdictNodes()).toEqual(new Set(['x', 'z']));
  });

  // ledger: D21
  test('a journal that is not there holds no verdict', async () => {
    expect(await createJournal(join(dir, 'gone.jsonl')).verdictNodes()).toEqual(new Set());
  });
});
