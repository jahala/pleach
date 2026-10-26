// ── a phased node's handback ────────────────────────────────────────────────
//
// A {test, phases} node runs several phases in one attempt, and the substance
// of its work is said at the end of the impl phase — what was built, what was
// scoped out, the dated Tried line — while the green phase's closing line only
// confirms the gate. The handback settle keeps is therefore not one message but
// every phase that ran in the final attempt, in order, each under its own
// heading. Pure and total: the phase list goes in, the text comes out; no fs,
// no processes, no clock.

// One phase's closing message, as the loop collected it.
export interface PhaseClosing {
  // The phase name the plan writes ('red' | 'impl' | 'green').
  name: string;
  // The phase's index in the plan's `phases` array (0-based). A name that
  // repeats in the list is disambiguated by appending it.
  index: number;
  // The closing message verbatim. Absent when the read failed or the message
  // was empty; those keep a note instead (issue #109).
  message?: string;
  // The runner could not read the closing message at the stop (issue #109).
  readFailure?: { exitCode: number; outputTail: string };
}

// The note a close keeps when the worker's message read back empty (issue #109).
export const EMPTY_HANDBACK = "The worker's final message was empty.\n";

// The note a close keeps when the runner could not read the message (issue
// #109): the failure is named, never other words in the worker's place.
export function readFailedHandback(read: { exitCode: number; outputTail: string }): string {
  const tail = read.outputTail.trim() === '' ? '(no output)' : read.outputTail;
  return (
    `The runner could not read the worker's final message (read exited ${read.exitCode}); ` +
    `the handback is missing.\nRunner output: ${tail}\n`
  );
}

// What a phase handed back: its message verbatim, or the note naming why there
// are no words — a failed read, or an empty message (issue #109).
function closingText(closing: PhaseClosing): string {
  if (closing.readFailure !== undefined) return readFailedHandback(closing.readFailure);
  if (closing.message !== undefined && closing.message !== '') return closing.message;
  return EMPTY_HANDBACK;
}

// A phase's heading: `## <name>`, with the plan's index appended when the name
// repeats in the list — `## impl` twice cannot be told apart without it.
function heading(closing: PhaseClosing, repeats: boolean): string {
  return `## ${closing.name}${repeats ? `[${closing.index}]` : ''}`;
}

// The handback a phased node keeps: each phase that ran, in order, under its
// own heading, its closing message (or the note naming a failed read or an
// empty message) beneath it.
export function assemblePhaseHandback(closings: readonly PhaseClosing[]): string {
  const counts = new Map<string, number>();
  for (const c of closings) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  return closings
    .map((c) => `${heading(c, (counts.get(c.name) ?? 0) > 1)}\n${closingText(c)}`)
    .join('\n');
}
