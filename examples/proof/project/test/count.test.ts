import { describe, expect, test } from 'bun:test';
import { countWords } from '../src/count.ts';

describe('countWords', () => {
  test('empty string returns 0', () => {
    expect(countWords('')).toBe(0);
  });

  test('blank/whitespace-only string returns 0', () => {
    expect(countWords('   ')).toBe(0);
    expect(countWords('\n\t')).toBe(0);
  });

  test('single word', () => {
    expect(countWords('hello')).toBe(1);
  });

  test('multiple words separated by spaces', () => {
    expect(countWords('hello world')).toBe(2);
  });

  test('multiple whitespace types (tabs, newlines)', () => {
    expect(countWords('one\ttwo\nthree')).toBe(3);
  });

  test('leading and trailing whitespace ignored', () => {
    expect(countWords('  hello world  ')).toBe(2);
  });
});
