import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IsolateCatastrophicError } from '../core/errors.ts';
import type { Node } from '../core/plan.ts';
import type { ExecFn, IsolateSeam, Isolation } from '../loop/deps.ts';

// ── helpers ─────────────────────────────────────────────────────────────────

async function git(
  exec: ExecFn,
  cwd: string,
  ...args: string[]
): Promise<{ output: string; exitCode: number }> {
  return exec(['git', '-C', cwd, ...args], { cwd });
}

async function gitMust(exec: ExecFn, cwd: string, ...args: string[]): Promise<string> {
  const r = await git(exec, cwd, ...args);
  if (r.exitCode !== 0) {
    throw new IsolateCatastrophicError(
      `git ${args.join(' ')}`,
      `exited ${r.exitCode} in ${cwd}:\n${r.output}`,
    );
  }
  return r.output.trim();
}

// ── createIsolateSeam ────────────────────────────────────────────────────────

export function createIsolateSeam(exec: ExecFn, repoRoot: string): IsolateSeam {
  // ── isolate ─────────────────────────────────────────────────────────────

  async function isolate(_node: Node, baseRefs: readonly string[]): Promise<Isolation> {
    if (baseRefs.length === 0) {
      throw new IsolateCatastrophicError('', 'baseRefs must not be empty');
    }

    // Create a tmp dir under os tmpdir — git worktree add needs a non-existent
    // (or empty) path, so we generate the prefix and let git create the final dir.
    const tmpBase = await mkdtemp(join(tmpdir(), 'pleach-'));

    // git worktree add --detach uses the path we give it; mkdtemp already
    // created the dir, so we need a sub-path that doesn't exist yet.
    const worktreePath = join(tmpBase, 'wt');

    // Detach at baseRefs[0]
    const addResult = await git(
      exec,
      repoRoot,
      'worktree',
      'add',
      '--detach',
      worktreePath,
      baseRefs[0],
    );

    if (addResult.exitCode !== 0) {
      throw new IsolateCatastrophicError(
        baseRefs[0],
        `git worktree add failed: ${addResult.output}`,
      );
    }

    // dispose helper (idempotent)
    const dispose = async (): Promise<void> => {
      const r = await git(exec, repoRoot, 'worktree', 'remove', '--force', worktreePath);
      // "is not a working tree" or "not found" are acceptable — already removed
      if (
        r.exitCode !== 0 &&
        !r.output.includes('is not a working tree') &&
        !r.output.includes('not found')
      ) {
        // tolerate already-removed silently — best effort
      }
    };

    const conflictFiles: string[] = [];

    // Sequential merges for refs[1..]
    for (const ref of baseRefs.slice(1)) {
      // Verify ref resolves (ledger B1)
      const verifyResult = await git(
        exec,
        worktreePath,
        'rev-parse',
        '--verify',
        '--quiet',
        `${ref}^{commit}`,
      );

      if (verifyResult.exitCode !== 0) {
        await dispose();
        throw new IsolateCatastrophicError(
          ref,
          `ref does not point to a commit: ${verifyResult.output}`,
        );
      }

      const mergeResult = await git(exec, worktreePath, 'merge', '--no-edit', ref);

      if (mergeResult.exitCode === 0) {
        // Clean merge — no action needed
        continue;
      }

      if (mergeResult.exitCode === 1) {
        // Conflict merge (exit 1) — check if this is actually a conflict
        // vs something catastrophic like unrelated histories
        const catastrophicPhrases = ['unrelated histories', 'does not point to a commit'];
        const isCatastrophic = catastrophicPhrases.some((p) =>
          mergeResult.output.toLowerCase().includes(p.toLowerCase()),
        );

        if (isCatastrophic) {
          await git(exec, worktreePath, 'merge', '--abort');
          await dispose();
          throw new IsolateCatastrophicError(ref, mergeResult.output.trim());
        }

        // Collect conflicted paths
        const diffResult = await git(exec, worktreePath, 'diff', '--name-only', '--diff-filter=U');
        const newConflicts = diffResult.output
          .trim()
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);

        for (const f of newConflicts) {
          if (!conflictFiles.includes(f)) conflictFiles.push(f);
        }

        // Commit the conflicted state with markers so subsequent merges can proceed
        // (ledger B3/C1 rationale: cannot continue a multi-ref chain with an
        // unconcluded merge; markers stay in committed files; the scanMarkers gate
        // catches them before any verified branch is published)
        await git(exec, worktreePath, 'add', '-A');
        await git(
          exec,
          worktreePath,
          'commit',
          '--no-edit',
          '-m',
          `merge ${ref} (conflicts kept as markers)`,
        );
        continue;
      }

      // exit >1: catastrophic
      // Try to abort any in-progress merge
      await git(exec, worktreePath, 'merge', '--abort');
      await dispose();
      throw new IsolateCatastrophicError(
        ref,
        `git merge exited ${mergeResult.exitCode}: ${mergeResult.output.trim()}`,
      );
    }

    return {
      cwd: worktreePath,
      conflictFiles,
      dispose,
    };
  }

  // ── scanMarkers ──────────────────────────────────────────────────────────

  async function scanMarkers(cwd: string): Promise<string[]> {
    // git grep -l --untracked -E '^(<{7}|={7}|>{7})'
    // Exit 1 = no matches (clean) — that's success.
    // Exit 0 = matches found.
    // Exit >1 = error.
    const r = await git(exec, cwd, 'grep', '-l', '--untracked', '-E', '^(<{7}|={7}|>{7})');

    if (r.exitCode === 1) {
      // No matches — clean
      return [];
    }

    if (r.exitCode === 0) {
      return r.output
        .trim()
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    }

    // exit >1: git itself failed. A gate that cannot run must fail CLOSED —
    // reporting "clean" here would let conflict markers reach a verified
    // branch (ledger C1).
    throw new IsolateCatastrophicError('git grep', `exited ${r.exitCode} in ${cwd}:\n${r.output}`);
  }

  // ── stage ────────────────────────────────────────────────────────────────

  async function stage(cwd: string, files: readonly string[]): Promise<void> {
    if (files.length === 0) return;
    // Scoped to exactly the given paths (ledger S1)
    await gitMust(exec, cwd, 'add', '-A', '--', ...files);
  }

  // ── commitBranch ─────────────────────────────────────────────────────────

  async function commitBranch(
    cwd: string,
    branch: string,
    message: string,
  ): Promise<{ sha: string }> {
    // --allow-empty because a verified command-node may legitimately change nothing
    // (ledger B2 — loop calls this BEFORE emitVerdict)
    await gitMust(exec, cwd, 'commit', '--allow-empty', '-m', message);
    await gitMust(exec, cwd, 'branch', '-f', branch, 'HEAD');
    const sha = await gitMust(exec, cwd, 'rev-parse', 'HEAD');
    return { sha };
  }

  // ── refSha ───────────────────────────────────────────────────────────────

  async function refSha(cwd: string, ref: string): Promise<string | null> {
    const r = await git(exec, cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    if (r.exitCode !== 0) return null;
    return r.output.trim() || null;
  }

  return { isolate, scanMarkers, stage, commitBranch, refSha };
}
