// W1 narration floor: the journal seam accepts an optional tee — a sync
// observer called with each event AFTER it is durably appended (narration
// mirrors the journal, never precedes it). A throwing tee must never corrupt
// the run: appends succeed regardless.
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournal } from '../../src/seams/journal.ts';

async function tmpJournal(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pleach-journal-tee-'));
  return join(dir, 'journal.jsonl');
}

describe('journal tee (W1 narration floor)', () => {
  test('tee observes every appended event, in order', async () => {
    const path = await tmpJournal();
    const seen: Record<string, unknown>[] = [];
    const journal = createJournal(path, (e) => seen.push(e));

    await journal.append({ event: 'run-start', nodes: 3 });
    await journal.append({ event: 'node-start', node: 'a' });

    expect(seen.map((e) => e.event)).toEqual(['run-start', 'node-start']);
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  test('a throwing tee never breaks the append', async () => {
    const path = await tmpJournal();
    const journal = createJournal(path, () => {
      throw new Error('renderer bug');
    });

    await journal.append({ event: 'closed', node: 'x', sha: 'abc' });

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string).event).toBe('closed');
  });

  test('no tee = unchanged behavior', async () => {
    const path = await tmpJournal();
    const journal = createJournal(path);
    await journal.append({ event: 'run-end' });
    expect((await readFile(path, 'utf8')).trim()).toContain('run-end');
  });
});
