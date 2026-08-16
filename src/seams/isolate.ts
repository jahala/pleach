import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IsolateCatastrophicError, LandBlockedError, LandConflictError } from '../core/errors.ts';
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
      if (r.exitCode !== 0) {
        if (!r.output.includes('is not a working tree') && !r.output.includes('not found')) {
          throw new IsolateCatastrophicError(
            'git worktree remove',
            `exited ${r.exitCode}: ${r.output.trim()}`,
          );
        }
      }
      // pleach created tmpBase via mkdtemp — we own it and must clean it up.
      // fs.rm is correct here per engineering doctrine: "Programmatic cleanup of
      // paths this code created uses git's own commands or fs.rm on paths we
      // provably own."
      await rm(tmpBase, { recursive: true, force: true });
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
        //
        // Use -u (update tracked files only), not -A. The worktree is freshly
        // created from a clean commit and a failed merge, so conflict markers
        // land exclusively in already-tracked files. -u stages exactly those
        // modifications without pulling in any untracked files that may exist
        // in the worktree (e.g. from a prior iteration of the loop). This is
        // scoped staging consistent with ledger S1/C2 doctrine.
        await git(exec, worktreePath, 'add', '-u');
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
    // Scoped to exactly the given paths (ledger S1). Workers legitimately
    // create-and-delete probe files (toolchain smoke checks); a pathspec that
    // matches neither the worktree NOR the index has nothing to stage and
    // must not fail the whole collection (a tracked file deleted by the
    // worker still matches the index, so its deletion stages normally).
    const keep: string[] = [];
    for (const file of files) {
      // gitMust: a broken environment (non-repo cwd) must still fail CLOSED —
      // ls-files itself exits 0 on unmatched pathspecs, so emptiness below
      // only ever means "nothing to stage for this path".
      const inTree = await gitMust(
        exec,
        cwd,
        'ls-files',
        '--others',
        '--exclude-standard',
        '--cached',
        '--',
        file,
      );
      if (inTree.trim() !== '') {
        keep.push(file);
        continue;
      }
      // Present-but-unlisted edge (fresh empty dirs): worktree existence probe
      // before dropping.
      const probe = await exec(['test', '-e', file.startsWith('/') ? file : `${cwd}/${file}`], {
        cwd,
      });
      if (probe.exitCode === 0) keep.push(file);
    }
    if (keep.length === 0) return;
    await gitMust(exec, cwd, 'add', '-A', '--', ...keep);
  }

  // ── changedFiles ─────────────────────────────────────────────────────────

  async function changedFiles(cwd: string): Promise<string[]> {
    // --porcelain=v1: "XY path" (or "XY old -> new" for renames). Untracked
    // ignored files are excluded by default — junk that .gitignore names can
    // never enter the staging set this way (ledger S1/C2).
    // NOTE: git() not gitMust() — gitMust trims, which eats the leading
    // status character's padding on the first porcelain line.
    const r = await git(exec, cwd, 'status', '--porcelain');
    if (r.exitCode !== 0) {
      throw new IsolateCatastrophicError(
        'git status --porcelain',
        `exited ${r.exitCode} in ${cwd}:\n${r.output}`,
      );
    }
    const files: string[] = [];
    for (const line of r.output.split('\n')) {
      if (line.length < 4) continue;
      const path = line.slice(3);
      const arrow = path.indexOf(' -> ');
      const final = arrow === -1 ? path : path.slice(arrow + 4);
      if (final.length > 0 && !files.includes(final)) files.push(final);
    }
    return files;
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

  // ── land ─────────────────────────────────────────────────────────────────

  async function land(
    landRepoRoot: string,
    refs: readonly string[],
  ): Promise<{ branch: string; sha: string }> {
    // The branch the user has checked out — landing target. Detached → refuse.
    const br = await git(exec, landRepoRoot, 'symbolic-ref', '--short', '-q', 'HEAD');
    if (br.exitCode !== 0) {
      throw new LandBlockedError('repo HEAD is detached — check out a branch to land onto');
    }
    const branch = br.output.trim();

    // Build the merges in a throwaway detached worktree at the branch tip
    // (same isolation model as node builds); the checkout is untouched until
    // the final fast-forward.
    const tmpBase = await mkdtemp(join(tmpdir(), 'pleach-land-'));
    const worktreePath = join(tmpBase, 'wt');
    const add = await git(exec, landRepoRoot, 'worktree', 'add', '--detach', worktreePath, branch);
    if (add.exitCode !== 0) {
      await rm(tmpBase, { recursive: true, force: true });
      throw new IsolateCatastrophicError(branch, `git worktree add failed: ${add.output}`);
    }
    const dispose = async (): Promise<void> => {
      const r = await git(exec, landRepoRoot, 'worktree', 'remove', '--force', worktreePath);
      if (r.exitCode !== 0) {
        if (!r.output.includes('is not a working tree') && !r.output.includes('not found')) {
          throw new IsolateCatastrophicError(
            'git worktree remove',
            `exited ${r.exitCode}: ${r.output.trim()}`,
          );
        }
      }
      await rm(tmpBase, { recursive: true, force: true });
    };

    try {
      for (const ref of refs) {
        const verify = await git(
          exec,
          worktreePath,
          'rev-parse',
          '--verify',
          '--quiet',
          `${ref}^{commit}`,
        );
        if (verify.exitCode !== 0) {
          throw new IsolateCatastrophicError(ref, `ref does not point to a commit`);
        }
        const merge = await git(exec, worktreePath, 'merge', '-m', `pleach: land ${ref}`, ref);
        if (merge.exitCode !== 0) {
          // A conflict must NEVER land — collect the files, abort, refuse
          // (the marker-keeping path of isolate() is for node builds only).
          const diff = await git(exec, worktreePath, 'diff', '--name-only', '--diff-filter=U');
          const files = diff.output
            .trim()
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
          await git(exec, worktreePath, 'merge', '--abort');
          throw new LandConflictError(ref, files);
        }
      }
      const sha = await gitMust(exec, worktreePath, 'rev-parse', 'HEAD');

      // The ONLY touch on the user's checkout. Refused when the branch moved
      // mid-land or uncommitted changes overlap — fail closed, explain.
      const ff = await git(exec, landRepoRoot, 'merge', '--ff-only', sha);
      if (ff.exitCode !== 0) {
        throw new LandBlockedError(`fast-forward of '${branch}' refused: ${ff.output.trim()}`);
      }
      return { branch, sha };
    } finally {
      await dispose();
    }
  }

  return { isolate, scanMarkers, stage, changedFiles, commitBranch, refSha, land };
}
