import { describe, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournal } from '../../src/seams/journal.ts';

describe('journal seam', () => {
  test('two appends produce two parseable lines in order', async () => {
    const journalPath = join(tmpdir(), `pleach-journal-test-${Date.now()}.jsonl`);
    try {
      const journal = createJournal(journalPath);
      await journal.append({ type: 'start', ts: 1 });
      await journal.append({ type: 'stop', ts: 2 });

      const raw = await readFile(journalPath, 'utf8');
      const lines = raw.trim().split('\n');
      expect(lines.length).toBe(2);

      const first = JSON.parse(lines[0]);
      const second = JSON.parse(lines[1]);
      expect(first).toEqual({ type: 'start', ts: 1 });
      expect(second).toEqual({ type: 'stop', ts: 2 });
    } finally {
      await rm(journalPath, { force: true });
    }
  });

  test('parent directory is auto-created on first append', async () => {
    const dir = join(tmpdir(), `pleach-journal-newdir-${Date.now()}`, 'nested', 'deep');
    const journalPath = join(dir, 'run.jsonl');
    try {
      const journal = createJournal(journalPath);
      await journal.append({ type: 'init' });

      const raw = await readFile(journalPath, 'utf8');
      const parsed = JSON.parse(raw.trim());
      expect(parsed).toEqual({ type: 'init' });
    } finally {
      // Clean up the created parent dirs
      const topDir = join(tmpdir(), journalPath.split(tmpdir())[1].split('/')[1]);
      await rm(topDir, { recursive: true, force: true });
    }
  });
});
