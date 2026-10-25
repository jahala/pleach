import { describe, expect, test } from 'bun:test';
import { REBUILD_REFS, rebuildRef } from '../../src/core/rebuild.ts';

describe('rebuildRef — the land-conflict pin (issue #116)', () => {
  test('names a node under the rebuild refs namespace', () => {
    expect(rebuildRef('scan')).toBe('refs/pleach/rebuild/scan');
    expect(rebuildRef('a.b.c')).toBe('refs/pleach/rebuild/a.b.c');
  });

  test('the namespace is a single shared prefix', () => {
    expect(REBUILD_REFS).toBe('refs/pleach/rebuild/');
    expect(rebuildRef('x').startsWith(REBUILD_REFS)).toBe(true);
  });
});
