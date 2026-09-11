import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Receipt, receiptPrefix } from '../core/receipt.ts';
import type { ArtifactKind, ReceiptListing, ReceiptStore } from '../loop/deps.ts';

// The node's close records under <git-dir>/pleach/receipts/ (§D). Node ids are
// refname-safe by schema ([A-Za-z0-9._-]), so the id IS the filename.
//
// A receipt is a record, not a slot (D17): a node id runs again — a retry, an
// acceptance-evolution re-dispatch — and the second close must not erase the
// first. So every write lands TWO files: `<node>.<sha256 prefix>.json`, the
// close's own, and `<node>.json`, whatever closed last. `previousReceiptSha256`
// links one to the next, and the receipt verb walks it.
//
// Gate artifacts (D14) sit beside their receipt under the same two names, so a
// kept findings log is found from the receipt without an index and is never the
// wrong close's. The un-prefixed name is the latest close's copy — which is why
// a close that keeps nothing must discard it (see run-plan's settle); what an
// earlier close kept stays under that close's own name, because nothing a
// worker produced is lost.
//
// read() returns null for missing OR unreadable — both callers degrade the
// same honest way: the acceptance-evolution check skips comparison (no record
// to compare), and the receipt verb reports UNDERIVABLE. Write errors
// propagate; run-plan's writeReceiptOrJournal owns the never-fail-a-close rule.

const ARTIFACT_EXTENSION: Record<ArtifactKind, string> = {
  sarif: '.sarif',
  friction: '.friction.jsonl',
  handback: '.handback.md',
};

// Each run's copy of its own journal lines (D21), beside the closes it made.
// A directory, so list() — which reads only `.json` files — never sees one.
const RUNS = 'runs';

// The close's own name; `<node><suffix>` is the same thing for the latest.
function ownName(node: string, receiptSha256: string, suffix: string): string {
  return `${node}.${receiptPrefix(receiptSha256)}${suffix}`;
}

async function readReceiptFile(path: string): Promise<Receipt | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    // No file, or one this process cannot read: null IS the answer here, and
    // it is the honest one — "no record" is what both callers act on (the
    // acceptance check skips comparison, the verb reports UNDERIVABLE). A
    // receipt store that threw would fail a close over a record it only reads.
    return null;
  }
  try {
    return JSON.parse(text) as Receipt;
  } catch {
    // Unreadable JSON is the same answer for the same reason: there is no
    // record to compare or verify. What the file says instead is not this
    // seam's to interpret.
    return null;
  }
}

async function forget(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    // No file is the common case — most closes keep nothing and have
    // nothing to forget. Anything else is a real failure of the store.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function createReceiptStore(dir: string): ReceiptStore {
  let dirReady: Promise<void> | null = null;

  function ensureDir(): Promise<void> {
    if (dirReady === null) {
      dirReady = mkdir(dir, { recursive: true }).then(() => undefined);
    }
    return dirReady;
  }

  function runJournalPath(runId: string): string {
    return join(dir, RUNS, `${runId}.journal.jsonl`);
  }

  return {
    async write(node: string, receipt: Receipt): Promise<void> {
      await ensureDir();
      const text = `${JSON.stringify(receipt, null, 2)}\n`;
      // The close's own file first: the latest is a pointer at a close, and it
      // must never name one whose record is not on disk yet.
      await writeFile(join(dir, ownName(node, receipt.sha256, '.json')), text, 'utf8');
      await writeFile(join(dir, `${node}.json`), text, 'utf8');
    },
    async writeArtifact(
      node: string,
      kind: ArtifactKind,
      bytes: string,
      receiptSha256: string,
    ): Promise<string> {
      await ensureDir();
      const suffix = ARTIFACT_EXTENSION[kind];
      const path = join(dir, ownName(node, receiptSha256, suffix));
      await writeFile(path, bytes, 'utf8');
      await writeFile(join(dir, `${node}${suffix}`), bytes, 'utf8');
      // The close's own file — the one its receipt names and its seal answers.
      return path;
    },
    async discardArtifact(node: string, kind: ArtifactKind, receiptSha256: string): Promise<void> {
      const suffix = ARTIFACT_EXTENSION[kind];
      // This close's own, and the latest — never an earlier close's, which is
      // sealed by its own receipt and is not this close's to drop.
      await forget(join(dir, ownName(node, receiptSha256, suffix)));
      await forget(join(dir, `${node}${suffix}`));
    },
    async read(node: string): Promise<Receipt | null> {
      return readReceiptFile(join(dir, `${node}.json`));
    },
    async readAt(node: string, receiptSha256: string): Promise<Receipt | null> {
      return readReceiptFile(join(dir, ownName(node, receiptSha256, '.json')));
    },
    async list(): Promise<ReceiptListing[]> {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (err) {
        // No store yet: nothing has closed here.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      const latest: ReceiptListing[] = [];
      for (const name of names.filter((n) => n.endsWith('.json'))) {
        const path = join(dir, name);
        const receipt = await readReceiptFile(path);
        // Node ids may hold dots, so the name alone cannot tell `<node>.json`
        // from a close's own `<node>.<prefix>.json`; the node the file records
        // can. Only the latest is listed — every close has one.
        if (receipt === null || name !== `${receipt.facts.node}.json`) continue;
        const { mtime } = await stat(path);
        latest.push({
          node: receipt.facts.node,
          sha256: receipt.sha256,
          closedAt: mtime.toISOString(),
        });
      }
      // In node order, never the directory's: `a.b.json` sorts before `a.json`.
      return latest.sort((x, y) => (x.node < y.node ? -1 : x.node > y.node ? 1 : 0));
    },
    runJournalPath,
    async writeRunJournal(runId: string, lines: readonly string[]): Promise<void> {
      await mkdir(join(dir, RUNS), { recursive: true });
      await writeFile(runJournalPath(runId), lines.map((l) => `${l}\n`).join(''), 'utf8');
    },
  };
}
