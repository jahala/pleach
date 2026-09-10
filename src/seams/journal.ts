import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
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
  };
}
