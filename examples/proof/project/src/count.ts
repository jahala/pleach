/**
 * Word, line, and character counting for plain text.
 *
 * Pre-seeded state: countWords is implemented.
 * The plan adds: countLines (s1), countChars (s2), stats (integration).
 */

/** Count whitespace-delimited tokens in text. Returns 0 for empty/blank input. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}
