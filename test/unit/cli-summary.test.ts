/**
 * Unit tests for summaryExitCode (src/faces/cli.ts).
 *
 * The exit code is the conductor's primary branch surface for shell callers.
 * Pure mapping: 0 only when every node verified-closed. A 'partial' node — work
 * landed, every gate green, but tend declined to verify-close — is NOT success;
 * it maps to 1 like failed/blocked/skipped (the JSON summary tells them apart).
 * The prior inline logic ignored 'partial', so a partial-only run reported 0.
 */
import { describe, expect, test } from 'bun:test';
import { summaryExitCode } from '../../src/faces/cli.ts';
import type { RunSummary } from '../../src/loop/deps.ts';

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return { closed: [], failed: [], partial: [], skipped: [], blocked: [], ...over };
}

describe('summaryExitCode', () => {
  test('all nodes closed → 0', () => {
    expect(summaryExitCode(summary({ closed: ['a', 'b'] }))).toBe(0);
  });

  test('empty plan (nothing to do) → 0', () => {
    expect(summaryExitCode(summary())).toBe(0);
  });

  test('a partial node (landed, not verified) → 1, not success', () => {
    expect(summaryExitCode(summary({ closed: ['a'], partial: ['b'] }))).toBe(1);
  });

  test('a failed node → 1', () => {
    expect(summaryExitCode(summary({ failed: ['a'] }))).toBe(1);
  });

  test('a blocked node → 1', () => {
    expect(summaryExitCode(summary({ blocked: ['a'] }))).toBe(1);
  });

  test('a skipped node → 1', () => {
    expect(summaryExitCode(summary({ skipped: ['a'] }))).toBe(1);
  });
});
