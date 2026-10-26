import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournal } from '../../src/seams/journal.ts';
import { ownFields } from '../support/journal.ts';

describe('journal seam', () => {
  test('two appends produce two parseable lines in order', async () => {
    // mkdtemp, not a Date.now() suffix: two suites that pick the same
    // millisecond would otherwise share one file (issue #160's fixed-name
    // class) and assert over each other's lines.
    const dir = await mkdtemp(join(tmpdir(), 'pleach-journal-test-'));
    const journalPath = join(dir, 'run.jsonl');
    try {
      const journal = createJournal(journalPath);
      await journal.append({ event: 'run-start', goal: 'two lines', nodes: 1 });
      await journal.append({ event: 'run-end', closed: 1 });

      const raw = await readFile(journalPath, 'utf8');
      const lines = raw.trim().split('\n');
      expect(lines.length).toBe(2);

      const first = JSON.parse(lines[0]);
      const second = JSON.parse(lines[1]);
      // The events' own fields, in the order they were appended (each line
      // also carries the envelope — pinned in journal-envelope.test.ts).
      expect(ownFields(first)).toEqual({ event: 'run-start', goal: 'two lines', nodes: 1 });
      expect(ownFields(second)).toEqual({ event: 'run-end', closed: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('parent directory is auto-created on first append', async () => {
    // mkdtemp for the same reason as the first test: the directory must be
    // this suite's alone.
    const dir = await mkdtemp(join(tmpdir(), 'pleach-journal-newdir-'));
    const journalPath = join(dir, 'nested', 'deep', 'run.jsonl');
    try {
      const journal = createJournal(journalPath);
      await journal.append({ event: 'run-start', goal: 'a nested journal', nodes: 1 });

      const raw = await readFile(journalPath, 'utf8');
      const parsed = JSON.parse(raw.trim());
      expect(ownFields(parsed)).toEqual({ event: 'run-start', goal: 'a nested journal', nodes: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
