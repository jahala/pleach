import type { Dirent } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CommitAlteredError,
  IsolateCatastrophicError,
  LandBlockedError,
  LandConflictError,
} from '../core/errors.ts';
import type { Node } from '../core/plan.ts';
import type { ExecFn, IsolateSeam, Isolation } from '../loop/deps.ts';
import { resolveGitDir } from './gitdir.ts';

// Where the friction ledger writes inside a worktree, as path segments
// (docs/plans/friction-ledger.md §5).
const FRICTION_DIR = ['.plotplot', 'friction'];
// What the work order tells a worker to write at the repo root when the plan
// cannot be finished here (D21).
const BLOCKED_FILE = 'BLOCKED.md';

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
  // `git worktree add`, `remove` and `list` each read every registered
  // worktree's admin dir, and one another command has half-written fails them
  // ("failed to read .git/worktrees/wt/commondir"). A run isolates its ready
  // nodes concurrently, so this seam runs them one at a time (D27).
  let worktreeTail: Promise<unknown> = Promise.resolve();
  function worktreeGit(cwd: string, ...args: string[]) {
    const run = worktreeTail.then(() => git(exec, cwd, 'worktree', ...args));
    worktreeTail = run.catch(() => undefined);
    return run;
  }

  async function worktreeBase(root: string): Promise<string> {
    const base = join(resolveGitDir(root), 'pleach', 'worktrees');
    await mkdir(base, { recursive: true });
    return base;
  }

  // ── isolate ─────────────────────────────────────────────────────────────

  async function isolate(_node: Node, baseRefs: readonly string[]): Promise<Isolation> {
    if (baseRefs.length === 0) {
      throw new IsolateCatastrophicError('', 'baseRefs must not be empty');
    }

    // Worktrees live under the git dir (D12) — findable by `pleach clean`,
    // and never in the OS temp reaper's shadow. mkdtemp gives the unique base;
    // git worktree add needs a non-existent sub-path.
    const tmpBase = await mkdtemp(join(await worktreeBase(repoRoot), 'wt-'));

    // git worktree add --detach uses the path we give it; mkdtemp already
    // created the dir, so we need a sub-path that doesn't exist yet.
    const worktreePath = join(tmpBase, 'wt');

    // Detach at baseRefs[0]
    const addResult = await worktreeGit(repoRoot, 'add', '--detach', worktreePath, baseRefs[0]);

    if (addResult.exitCode !== 0) {
      throw new IsolateCatastrophicError(
        baseRefs[0],
        `git worktree add failed: ${addResult.output}`,
      );
    }

    // dispose helper (idempotent)
    const dispose = async (): Promise<void> => {
      const r = await worktreeGit(repoRoot, 'remove', '--force', worktreePath);
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

  // ── ignored ──────────────────────────────────────────────────────────────

  async function ignored(cwd: string, paths: readonly string[]): Promise<string[]> {
    if (paths.length === 0) return [];
    // The index is consulted deliberately (NOT --no-index): a TRACKED file
    // that matches an ignore rule stages fine, so a change to it IS delivery
    // and must never be set aside. core.quotePath=false keeps non-ASCII paths
    // readable back as the bytes we passed in, and the answer is the caller's
    // own paths — only what they named can be set aside.
    const r = await git(exec, cwd, '-c', 'core.quotePath=false', 'check-ignore', '--', ...paths);
    // Exit 1 = no path is ignored: check-ignore's documented "no match", not a
    // failure. Anything else is git itself failing and must not pass silently
    // — reporting "nothing ignored" would hand the ignored path to `git add`.
    if (r.exitCode === 1) return [];
    if (r.exitCode !== 0) {
      throw new IsolateCatastrophicError(
        'git check-ignore',
        `exited ${r.exitCode} in ${cwd}:\n${r.output}`,
      );
    }
    const reported = new Set(r.output.split('\n').filter((l) => l !== ''));
    return paths.filter((p) => reported.has(p));
  }

  // ── readFriction ─────────────────────────────────────────────────────────

  async function readFriction(cwd: string): Promise<string | null> {
    const dir = join(cwd, ...FRICTION_DIR);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // No `.plotplot/friction/` is the common case — most trees never see a
      // friction ledger. Absence is an answer, not a failure.
      return null;
    }
    // Month files only, and only the ones directly here: the ledger keeps its
    // cursor under `state/` and its rollup in `hotspots.json`, and neither is
    // the journal. Filename order IS chronological order for `<yyyy-mm>`.
    const months = entries
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => e.name)
      .sort();
    if (months.length === 0) return null;
    const text = await Promise.all(months.map((name) => readFile(join(dir, name), 'utf8')));
    return text.join('');
  }

  // ── readBlocked ──────────────────────────────────────────────────────────

  async function readBlocked(cwd: string): Promise<string | null> {
    try {
      return await readFile(join(cwd, BLOCKED_FILE), 'utf8');
    } catch (err) {
      // No file at the root — or a directory by that name — is the common
      // answer: the worker did not say it was blocked.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') return null;
      throw new IsolateCatastrophicError(
        `read ${BLOCKED_FILE}`,
        `${err instanceof Error ? err.message : String(err)} in ${cwd}`,
      );
    }
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
    // --untracked-files=all because the default collapses a directory git has
    // never seen to "dir/" and stops naming what is inside it. This list is
    // the staged set: it is what the red seal journals (D13), what the receipt
    // counts, and what auditGateTampering matches the audit command's tokens
    // against — a path that never appears individually is a path no per-file
    // check can see, so a worker's file lands unnamed simply for being in a
    // new directory.
    // NOTE: git() not gitMust() — gitMust trims, which eats the leading
    // status character's padding on the first porcelain line.
    const r = await git(exec, cwd, 'status', '--porcelain', '--untracked-files=all');
    if (r.exitCode !== 0) {
      throw new IsolateCatastrophicError(
        'git status --porcelain --untracked-files=all',
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

  // ── stagedDiff / stagedNumstat (the hygiene gate's raw material, §E) ────

  async function stagedDiff(cwd: string): Promise<string> {
    const r = await git(exec, cwd, 'diff', '--cached');
    if (r.exitCode !== 0) {
      throw new IsolateCatastrophicError('git diff --cached', `exited ${r.exitCode}: ${r.output}`);
    }
    return r.output;
  }

  async function stagedNumstat(
    cwd: string,
  ): Promise<{ file: string; added: number; deleted: number }[]> {
    const r = await git(exec, cwd, 'diff', '--cached', '--numstat');
    if (r.exitCode !== 0) {
      throw new IsolateCatastrophicError(
        'git diff --cached --numstat',
        `exited ${r.exitCode}: ${r.output}`,
      );
    }
    const out: { file: string; added: number; deleted: number }[] = [];
    for (const line of r.output.split('\n')) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const added = Number(parts[0]);
      const deleted = Number(parts[1]);
      // Binary files report '-': skip — the text detectors have nothing to read.
      if (!Number.isFinite(added) || !Number.isFinite(deleted)) continue;
      out.push({ file: parts.slice(2).join('\t'), added, deleted });
    }
    return out;
  }

  // ── stagedPaths (what the receipt counts, D19) ──────────────────────────

  async function stagedPaths(cwd: string): Promise<string[]> {
    // core.quotePath=false: git otherwise answers a non-ASCII path in its
    // quoted octal form, which names no file. A git that cannot read the index
    // must fail CLOSED — "nothing staged" would be a fact nobody observed.
    const r = await git(exec, cwd, '-c', 'core.quotePath=false', 'diff', '--cached', '--name-only');
    if (r.exitCode !== 0) {
      throw new IsolateCatastrophicError(
        'git diff --cached --name-only',
        `exited ${r.exitCode} in ${cwd}:\n${r.output}`,
      );
    }
    return r.output.split('\n').filter((l) => l !== '');
  }

  // ── commit ───────────────────────────────────────────────────────────────

  // Commit what is staged and refuse a commit whose tree is not the staged one
  // (D24). The repository's hooks run inside `git commit` (D21) and may change
  // the index there; bytes no gate judged must never be committed as judged.
  // On a difference HEAD goes back to its parent (no hook runs on that, as for
  // the snapshot) and the index keeps what the hook did, for the quarantine.
  async function commitJudged(cwd: string, ...args: string[]): Promise<string> {
    const parent = await gitMust(exec, cwd, 'rev-parse', 'HEAD');
    const judged = await gitMust(exec, cwd, 'write-tree');
    await gitMust(exec, cwd, 'commit', ...args);
    const committed = await gitMust(exec, cwd, 'rev-parse', 'HEAD^{tree}');
    if (committed !== judged) {
      const changed = await gitMust(
        exec,
        cwd,
        'diff-tree',
        '-r',
        '--name-status',
        judged,
        committed,
      );
      await gitMust(
        exec,
        cwd,
        '-c',
        'core.hooksPath=/dev/null',
        'update-ref',
        '--no-deref',
        'HEAD',
        parent,
      );
      throw new CommitAlteredError(changed);
    }
    return gitMust(exec, cwd, 'rev-parse', 'HEAD');
  }

  // The phase seal (D13): a commit on the worktree's detached HEAD. No branch
  // move — `node/<id>` is published at settle only, so the close commits on top
  // of this one and the history reads base → red → verified. No --allow-empty
  // either: an empty seal would claim a red state that changed nothing.
  async function commit(cwd: string, message: string): Promise<{ sha: string }> {
    return { sha: await commitJudged(cwd, '-m', message) };
  }

  // ── commitBranch ─────────────────────────────────────────────────────────

  async function commitBranch(
    cwd: string,
    branch: string,
    message: string,
  ): Promise<{ sha: string }> {
    // --allow-empty because a verified command-node may legitimately change nothing
    // (ledger B2 — loop calls this BEFORE emitVerdict)
    const sha = await commitJudged(cwd, '--allow-empty', '-m', message);
    await gitMust(exec, cwd, 'branch', '-f', branch, sha);
    return { sha };
  }

  // ── snapshot ─────────────────────────────────────────────────────────────

  // The quarantine (D21): what is staged, kept on `branch` by plumbing alone.
  // A repository's hooks gate what it publishes, never whether pleach keeps the
  // evidence of what failed. write-tree and commit-tree run no hook;
  // update-ref runs reference-transaction, which can abort it, so it runs with
  // the hooks path pointed at nothing. The detached HEAD stays where it is.
  async function snapshot(cwd: string, branch: string, message: string): Promise<{ sha: string }> {
    // update-ref moves a branch another worktree has checked out; `git branch
    // -f` refuses that and so must this — the owner's HEAD would jump to a tree
    // their index and files do not hold (#12). Same words as git's refusal, so
    // the caller's busy-branch fallback reads both alike.
    const holder = await checkedOutAt(cwd, branch);
    if (holder !== null) {
      throw new IsolateCatastrophicError(
        branch,
        `cannot force update the branch '${branch}' used by worktree at '${holder}'`,
      );
    }
    const tree = await gitMust(exec, cwd, 'write-tree');
    const sha = await gitMust(exec, cwd, 'commit-tree', tree, '-p', 'HEAD', '-m', message);
    await gitMust(
      exec,
      cwd,
      '-c',
      'core.hooksPath=/dev/null',
      'update-ref',
      `refs/heads/${branch}`,
      sha,
    );
    return { sha };
  }

  // The worktree that has `branch` checked out, or null. -z keeps any path
  // intact: every attribute ends in NUL, and `worktree` opens each record.
  async function checkedOutAt(cwd: string, branch: string): Promise<string | null> {
    const list = await worktreeGit(cwd, 'list', '--porcelain', '-z');
    if (list.exitCode !== 0) {
      throw new IsolateCatastrophicError(
        'git worktree list',
        `exited ${list.exitCode} in ${cwd}:\n${list.output}`,
      );
    }
    let path: string | null = null;
    for (const attr of list.output.split('\0')) {
      if (attr.startsWith('worktree ')) path = attr.slice('worktree '.length);
      else if (attr === `branch refs/heads/${branch}`) return path;
    }
    return null;
  }

  // ── refSha ───────────────────────────────────────────────────────────────

  async function refSha(cwd: string, ref: string): Promise<string | null> {
    const r = await git(exec, cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    if (r.exitCode !== 0) return null;
    return r.output.trim() || null;
  }

  async function commitMessageOf(cwd: string, ref: string): Promise<string | null> {
    const r = await git(exec, cwd, 'show', '-s', '--format=%B', `${ref}^{commit}`);
    if (r.exitCode !== 0) return null;
    return r.output;
  }

  // What `ref` introduced, as git's own --stat summary (`--format=` drops the
  // header, so the output is the file list and its totals and nothing else).
  // A ref that doesn't resolve and a commit that changed nothing are the same
  // answer here — null, "there is no stat to show" — because the caller (the
  // resume evidence, D17) has something to say either way.
  async function commitStat(cwd: string, ref: string): Promise<string | null> {
    const r = await git(exec, cwd, 'show', '--stat', '--format=', `${ref}^{commit}`);
    if (r.exitCode !== 0) return null;
    return r.output.trim() || null;
  }

  // ── land ─────────────────────────────────────────────────────────────────

  async function landStack(
    landRepoRoot: string,
    refs: readonly string[],
  ): Promise<import('../loop/deps.ts').LandStack> {
    // The branch the user has checked out — landing target. Detached → refuse.
    const br = await git(exec, landRepoRoot, 'symbolic-ref', '--short', '-q', 'HEAD');
    if (br.exitCode !== 0) {
      throw new LandBlockedError('repo HEAD is detached — check out a branch to land onto');
    }
    const branch = br.output.trim();

    // Build the merges in a throwaway detached worktree at the branch tip
    // (same isolation model as node builds); the checkout is untouched until
    // the final fast-forward.
    const tmpBase = await mkdtemp(join(await worktreeBase(landRepoRoot), 'land-'));
    const worktreePath = join(tmpBase, 'wt');
    const add = await worktreeGit(landRepoRoot, 'add', '--detach', worktreePath, branch);
    if (add.exitCode !== 0) {
      await rm(tmpBase, { recursive: true, force: true });
      throw new IsolateCatastrophicError(branch, `git worktree add failed: ${add.output}`);
    }
    const dispose = async (): Promise<void> => {
      const r = await worktreeGit(landRepoRoot, 'remove', '--force', worktreePath);
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
      // The tip the stack is built on, read before the first merge: what a
      // land gate's `{base}` resolves to, and the only moment it is knowable.
      const baseSha = await gitMust(exec, worktreePath, 'rev-parse', 'HEAD');

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
      // The stack is built and unpublished; the loop gates it in `cwd`, then
      // publishes or disposes. Publish is the ONLY touch on the user's
      // checkout — refused when the branch moved mid-land or uncommitted
      // changes overlap; fail closed, explain.
      return {
        cwd: worktreePath,
        baseSha,
        publish: async (): Promise<{ branch: string; sha: string }> => {
          const tip = await gitMust(exec, worktreePath, 'rev-parse', 'HEAD');
          const ff = await git(exec, landRepoRoot, 'merge', '--ff-only', tip);
          if (ff.exitCode !== 0) {
            throw new LandBlockedError(`fast-forward of '${branch}' refused: ${ff.output.trim()}`);
          }
          return { branch, sha: tip };
        },
        dispose,
      };
    } catch (err) {
      // Building the stack failed — nothing to hand back; clean up here.
      await dispose();
      throw err;
    }
  }

  return {
    isolate,
    scanMarkers,
    ignored,
    readFriction,
    readBlocked,
    stage,
    stagedDiff,
    stagedNumstat,
    stagedPaths,
    changedFiles,
    commit,
    commitBranch,
    snapshot,
    refSha,
    commitMessageOf,
    commitStat,
    landStack,
  };
}
