import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { JournalRunMissingError } from '../core/errors.ts';
import { envelope } from '../core/journal-envelope.ts';
import type { JournalSeam } from '../loop/deps.ts';

// Append-only JSONL run journal. Each call wraps `event` in the garden's one
// event envelope (core/journal-envelope.ts — ledger D15), serialises the
// result to a single JSON line followed by '\n' and appends it to `path`. The
// parent directory is created on first append (recursive mkdir is idempotent).
//
// The seam is where the envelope is applied because it is where the clock is:
// `envelope` is pure and takes the instant as a parameter, so the one impure
// fact — what time it is — lives at the edge with the write it stamps. The
// loop keeps appending the events it always appended; nothing upstream knows.
//
// Errors from the underlying fs calls are NOT swallowed: a real filesystem
// error (permissions, disk full, etc.) propagates as a typed NodeJS error so
// the face can map it to an exit code. Silently swallowing I/O failures would
// let a corrupted run continue undetected.

// The optional `tee` observes each event AFTER its durable append (narration
// mirrors the journal, never precedes it) and is exception-proofed: a
// rendering bug in an observer must never corrupt a run.
export function createJournal(
  path: string,
  tee?: (event: Record<string, unknown>) => void,
): JournalSeam {
  const dir = dirname(path);
  // Track whether we've confirmed the directory exists so we only pay the
  // mkdir cost once per journal instance, not once per append.
  let dirReady: Promise<void> | null = null;

  function ensureDir(): Promise<void> {
    if (dirReady === null) {
      dirReady = mkdir(dir, { recursive: true }).then(() => undefined);
    }
    return dirReady;
  }

  return {
    async append(event: Record<string, unknown>): Promise<void> {
      // Enveloped before the mkdir so an unknown event name fails loudly
      // without leaving a half-made journal directory behind.
      const line = envelope(event, new Date());
      await ensureDir();
      await appendFile(path, `${JSON.stringify(line)}\n`, 'utf8');
      if (tee) {
        try {
          // The same line the file holds: an observer that re-derived the
          // envelope would be a second source of truth for it.
          tee(line);
        } catch {
          // A narration failure is cosmetic; the journal line is already safe.
        }
      }
    },
    async verdictNodes(): Promise<Set<string>> {
      const nodes = new Set<string>();
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        // A journal that is not there holds no verdict — the very gap the
        // receipts witness (D21). Any other failure is the reader's to journal.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return nodes;
        throw err;
      }
      for (const raw of text.split('\n')) {
        const line = parseLine(raw);
        if (line?.event === 'verdict' && typeof line.node === 'string') nodes.add(line.node);
      }
      return nodes;
    },
    async linesSince(runId: string): Promise<string[]> {
      const lines = (await readFile(path, 'utf8')).split('\n').filter((raw) => raw !== '');
      // The latest start carrying the id: the run asking is the newest one.
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = parseLine(lines[i] as string);
        if (line?.event === 'run-start' && line.runId === runId) return lines.slice(i);
      }
      throw new JournalRunMissingError(path, runId);
    },
  };
}

// One journal line as an object, or null when it is not one.
function parseLine(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    // A line this seam did not write whole (a torn append, a hand edit, the
    // empty tail after the last newline) is not a verdict line. Dropping it
    // keeps the rest of the record readable, and null is that answer.
    return null;
  }
}
