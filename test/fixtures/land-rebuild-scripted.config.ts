import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunnerSeam, WorkerResult } from 'pleach';
import { gitLedger } from 'pleach/adapters/git';
import type { PleachConfig } from 'pleach/config';

// issue #116 — a real, deterministic RunnerSeam with no LLM, no keys, no
// network. A build worker writes its own line into shared.txt on a first build;
// when the tree already holds conflict markers (the node re-run on the landed
// stack, its own verified branch merged on top), it resolves them by keeping
// both sides, exactly what a worker integrating a sibling's change must do.
// The marker branch is what distinguishes the rebuild from the first build:
// a first build writes one line, a rebuild produces both.

const FILE = 'shared.txt';

function resolveMarkers(text: string): string {
  return text.replace(
    /<<<<<<< [^\n]*\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> [^\n]*(?:\n|$)/g,
    (_all, ours: string, theirs: string) => {
      const a = ours.replace(/\n+$/, '');
      const b = theirs.replace(/\n+$/, '');
      return `${a}\n${b}\n`;
    },
  );
}

function stop(message: string, files: string[]): WorkerResult {
  return { finalMessage: message, filesTouched: files, reason: 'stop', telemetry: {} };
}

function runner(): RunnerSeam {
  return {
    async spawnWorker(spec) {
      let lastPrompt = '';
      return {
        async send(text: string) {
          lastPrompt = text;
        },
        async wait(): Promise<WorkerResult> {
          const abs = join(spec.cwd, FILE);
          let current = '';
          try {
            current = await readFile(abs, 'utf8');
          } catch {
            // First build: the file does not exist yet.
          }
          if (current.includes('<<<<<<<')) {
            await writeFile(abs, resolveMarkers(current));
            return stop('resolved shared.txt keeping both changes', [FILE]);
          }
          const line = lastPrompt.includes('write A') ? 'A\n' : 'B\n';
          await writeFile(abs, line);
          return stop(`wrote ${line.trim()}`, [FILE]);
        },
        kill: () => Promise.resolve(),
      };
    },
  };
}

export default {
  runner: runner(),
  ledger: gitLedger(),
} satisfies PleachConfig;
