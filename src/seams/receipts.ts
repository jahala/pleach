import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Receipt } from '../core/receipt.ts';
import type { ReceiptStore } from '../loop/deps.ts';

// One JSON file per node under <git-dir>/pleach/receipts/ (§D). Node ids are
// refname-safe by schema ([A-Za-z0-9._-]), so the id IS the filename.
//
// read() returns null for missing OR unreadable — both callers degrade the
// same honest way: the acceptance-evolution check skips comparison (no record
// to compare), and the receipt verb reports UNDERIVABLE. Write errors
// propagate; run-plan's writeReceiptOrJournal owns the never-fail-a-close rule.
export function createReceiptStore(dir: string): ReceiptStore {
  let dirReady: Promise<void> | null = null;

  function ensureDir(): Promise<void> {
    if (dirReady === null) {
      dirReady = mkdir(dir, { recursive: true }).then(() => undefined);
    }
    return dirReady;
  }

  return {
    async write(node: string, receipt: Receipt): Promise<void> {
      await ensureDir();
      await writeFile(join(dir, `${node}.json`), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    },
    async read(node: string): Promise<Receipt | null> {
      let text: string;
      try {
        text = await readFile(join(dir, `${node}.json`), 'utf8');
      } catch {
        return null;
      }
      try {
        return JSON.parse(text) as Receipt;
      } catch {
        return null;
      }
    },
  };
}
