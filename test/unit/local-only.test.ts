// issue #130: pleach says when verified work exists only on this machine.
//
// The pure core (src/core/local-only.ts) computes, from the local refs and the
// remote-tracking refs (as data — the isolate seam gathers them over local git
// only), which verified node/* branches are on no remote, how many remotes
// exist, and how far ahead of its upstream a landed branch is.
import { describe, expect, test } from 'bun:test';
import { aheadOfUpstream, computeLocalOnly } from '../../src/core/local-only.ts';

describe('computeLocalOnly (issue #130)', () => {
  test('no remotes and no node branches → empty report, zero remotes', () => {
    const report = computeLocalOnly({
      nodeBranches: [],
      reachableFromRemote: new Set(),
      remotes: 0,
    });
    expect(report).toEqual({ nodeBranches: [], remotes: 0 });
  });

  test('every node branch on no remote is named, sorted', () => {
    const report = computeLocalOnly({
      nodeBranches: [
        { name: 'node/b', sha: 'b' },
        { name: 'node/a', sha: 'a' },
      ],
      reachableFromRemote: new Set(),
      remotes: 1,
    });
    expect(report).toEqual({ nodeBranches: ['node/a', 'node/b'], remotes: 1 });
  });

  test('a node branch contained in a remote is not local-only', () => {
    const report = computeLocalOnly({
      nodeBranches: [
        { name: 'node/a', sha: 'a' },
        { name: 'node/b', sha: 'b' },
      ],
      reachableFromRemote: new Set(['a']),
      remotes: 1,
    });
    expect(report).toEqual({ nodeBranches: ['node/b'], remotes: 1 });
  });

  test('hundreds of node branches all compute and stay sorted', () => {
    const nodeBranches = Array.from({ length: 500 }, (_, i) => ({
      name: `node/n${String(i).padStart(4, '0')}`,
      sha: `sha-${i}`,
    }));
    const reachableFromRemote = new Set(['sha-250', 'sha-499']);
    const report = computeLocalOnly({ nodeBranches, reachableFromRemote, remotes: 2 });
    expect(report.nodeBranches).toHaveLength(498);
    expect(report.nodeBranches).not.toContain('node/n0250');
    expect(report.nodeBranches).not.toContain('node/n0499');
    expect(report.nodeBranches[0]).toBe('node/n0000');
    expect(report.nodeBranches[497]).toBe('node/n0498');
    expect(report.remotes).toBe(2);
  });
});

describe('aheadOfUpstream (issue #130)', () => {
  test('a branch with an upstream reports the count', () => {
    expect(aheadOfUpstream({ upstream: 'origin/main', ahead: 27 })).toBe(27);
  });

  test('a branch with no upstream reports null', () => {
    expect(aheadOfUpstream({ upstream: null, ahead: 0 })).toBeNull();
  });

  test('zero ahead is zero, not null', () => {
    expect(aheadOfUpstream({ upstream: 'origin/main', ahead: 0 })).toBe(0);
  });
});
