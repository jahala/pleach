import { describe, expect, test } from 'bun:test';
import { emptyBoard } from '../src/ttt.ts';

describe('emptyBoard', () => {
  test('returns nine empty cells', () => {
    expect(emptyBoard()).toEqual(['', '', '', '', '', '', '', '', '']);
  });
});
