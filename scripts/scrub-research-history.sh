#!/usr/bin/env bash
# scrub-research-history.sh — remove private paths from pleach's published history.
#
# WHY: docs/research/ was tracked on master from 2026-06-18 until commit 2bd65bc
# deleted it. Seven files survive in history and are reachable from master and from
# 49 of the 50 remote branches: internal notes, an internal whole-project audit, and a
# verbatim dialogue archive. Flipping the repository to public publishes all of it. After the flip it is
# in GitHub's caches, in forks, and in archives, so the scrub has to happen first.
#
#   scripts/scrub-research-history.sh prepare
#   scripts/scrub-research-history.sh push
#   scripts/scrub-research-history.sh verify-remote   (read-only; any time)
#
# `prepare` touches nothing published: it backs up the remote, rewrites a throwaway
# mirror, and proves the result. Read its report, then run `push`.
#
# Requires git-filter-repo (brew install git-filter-repo), trash, and gh auth.
#
# ── history of this script ───────────────────────────────────────────────────
# The first version's verification was wrong in three ways and reported five
# false failures on a rewrite that was in fact correct. All three are fixed here,
# and the third mattered most:
#
#   1. It compared against the backup by fetching it INTO the mirror, then scanned
#      `--all`. That re-imported the very history it was checking for, so the path
#      and canary checks could never pass. Verification is now read-only and
#      cross-repo: nothing is ever fetched into the mirror.
#   2. It predicted the commit-count drop from content commits alone, ignoring merge
#      commits that become empty when their whole payload is dropped. The count
#      prediction is gone, replaced by an audit of git-filter-repo's own commit-map,
#      which is authoritative: every dropped commit must be confined to the dropped
#      paths or be a merge that went empty.
#   3. The fetch in (1) left `refs/backup/*` and `refs/remotes/backup/*` in the
#      mirror: 100 refs of UNREWRITTEN history. The push was `--force --mirror`,
#      which pushes every ref, so it would have published the full pre-scrub history
#      including docs/research. The scrub would have shipped exactly what it exists
#      to remove. The push is now explicit refspecs for heads and tags only.
#
# A mirror clone of a GitHub repo also carries `refs/pull/*` (67 here). Those are
# rewritten like anything else, but GitHub refuses pushes to them, so they must stay
# local. The explicit refspecs handle that too.
#
# The after-push check had the same blind spot the other way round: it scanned
# GitHub's copy with `--branches --tags` only. GitHub keeps every pull request's
# head on `refs/pull/<n>/head`, and no push can rewrite those or a merged pull
# request's diff. The check now reads every ref GitHub serves, and
# `verify-remote` runs it on its own. Only GitHub Support, or a fresh
# repository, removes what pull requests hold.

set -euo pipefail

# ── what to drop ─────────────────────────────────────────────────────────────
#
# One rewrite is much cheaper than two: every extra pass re-breaks every PR link
# and forces everyone to re-clone again. Settle the full list before running.
#
# docs/research  — private by rule (.gitignore, CLAUDE.md). Absent from every branch
#                  tip today, so dropping it changes no current content.
# .brand         — checked, and deliberately NOT dropped. The umbrella files are cached
#                  from github.com/jahala/plotplot, which is public, so publishing them
#                  leaks nothing; the rest is pleach's own product layer, which .petalsrc
#                  says is committed on purpose.
PATHS_TO_DROP=(
  docs/research
)

REMOTE_URL="https://github.com/jahala/pleach.git"
WORK_ROOT="${PLEACH_SCRUB_ROOT:-$HOME/pleach-history-scrub}"
BACKUP="$WORK_ROOT/backup-pre-scrub.git"
MIRROR="$WORK_ROOT/rewritten.git"

# The canary list and the redaction list are the same file, and it lives OUTSIDE the
# repository on purpose: one line per sensitive string, never committed.
#
# This script used to hard-code the canaries. That was the leak it exists to prevent:
# three of those strings sat in plain text in a tracked file, so publishing the repo
# would have published exactly the references the scrub removes. Its own canary scan
# caught it on 2026-09-20, in three blobs, all of them earlier versions of this file.
#
# Those stale blobs are still in history, so when this file is present it is also
# passed to git-filter-repo as --replace-text, which rewrites those bytes out of every
# blob on every ref. Bare literal lines are valid for both uses.
REDACT_FILE="${PLEACH_SCRUB_REDACT:-$WORK_ROOT/redact.txt}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[32mok\033[0m    %s\n' "$*"; }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

require_tools() {
  command -v git-filter-repo >/dev/null 2>&1 \
    || die "git-filter-repo not on PATH. brew install git-filter-repo"
  command -v trash >/dev/null 2>&1 \
    || die "trash not on PATH. This script never rm's; brew install trash"
}

# True when $1 sits under one of PATHS_TO_DROP.
is_dropped_path() {
  local p="$1" prefix
  for prefix in "${PATHS_TO_DROP[@]}"; do
    case "$p" in "$prefix"|"$prefix"/*) return 0 ;; esac
  done
  return 1
}

# The refs that will actually be published. Everything else in the mirror
# (refs/pull/* from the clone) stays local and is never pushed.
publishable_refs() {
  git -C "$MIRROR" for-each-ref --format='%(refname)' refs/heads refs/tags
}

# Read-only. Never writes to $MIRROR, never fetches anything into it.
verify_mirror() {
  local failures=0 cn=0
  say "Verifying $MIRROR (read-only; the backup is never fetched in)"

  if git -C "$MIRROR" for-each-ref --format='%(refname)' | grep -q '^refs/\(backup\|remotes\)/'; then
    die "$MIRROR contains refs/backup or refs/remotes. An older version of this script
fetched the pre-scrub history into the mirror; pushing it would republish everything
this scrub removes. Run: trash '$MIRROR' && $0 prepare"
  fi
  ok "no pre-scrub refs were imported into the mirror"

  # 1. No publishable commit touches a dropped path. `--branches --tags` selects
  #    exactly the refs that get pushed; passing an explicit ref list here blew the
  #    argument limit and silently scanned nothing, which reads as a pass.
  local path_hits
  path_hits=$(git -C "$MIRROR" log --branches --tags --oneline -- "${PATHS_TO_DROP[@]}" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$path_hits" = "0" ]; then ok "no publishable commit touches: ${PATHS_TO_DROP[*]}"
  else bad "$path_hits publishable commits still touch the dropped paths"; failures=$((failures + 1)); fi

  # 2. No publishable blob carries the content. A path filter cannot see a copy that
  #    was ever committed under a different name; the bytes can.
  local blobs
  blobs=$(git -C "$MIRROR" rev-list --objects --branches --tags \
    | awk '{print $1}' | sort -u \
    | git -C "$MIRROR" cat-file --batch-check='%(objectname) %(objecttype)' 2>/dev/null \
    | awk '$2=="blob" {print $1}')
  ok "scanning $(printf '%s\n' "$blobs" | grep -c . || echo 0) publishable blobs"

  # 2a. Exact, and needs no strings: no blob that ever lived at a dropped path in the
  #     backup may survive in the publishable set.
  local before_blobs survivors
  # `is_dropped_path "$p" && echo` as the loop's last command makes the loop exit
  # non-zero whenever the final line is not a dropped path. Under `set -euo pipefail`
  # that killed the whole script mid-verification, silently, with status 0. Use an
  # explicit `if`, which is 0 when the condition is false.
  before_blobs=$(git -C "$BACKUP" rev-list --objects --branches --tags \
    | awk 'NF>1' \
    | while read -r sha path; do
        if is_dropped_path "$path"; then echo "$sha"; fi
      done \
    | sort -u || true)
  if [ -z "$before_blobs" ]; then
    ok "backup has no blobs at the dropped paths to check against"
  else
    survivors=$(comm -12 <(printf '%s\n' "$before_blobs") <(printf '%s\n' "$blobs" | sort -u) | grep -c . || true)
    if [ "$survivors" = "0" ]; then
      ok "none of the $(printf '%s\n' "$before_blobs" | grep -c .) dropped-path blobs survive"
    else bad "$survivors dropped-path blobs still reachable"; failures=$((failures + 1)); fi
  fi

  # 2b. Content-level, for a copy that was committed elsewhere under another name.
  #     Strings come from the external redact file, never from this script.
  if [ ! -f "$REDACT_FILE" ]; then
    bad "no redact/canary file at $REDACT_FILE; the content-level check cannot run"
    failures=$((failures + 1))
  else
    local canary hits
    while IFS= read -r canary; do
      [ -n "$canary" ] || continue
      hits=$(printf '%s\n' "$blobs" | git -C "$MIRROR" cat-file --batch 2>/dev/null \
        | grep -a -c -F -- "$canary" || true)
      if [ "$hits" = "0" ]; then ok "absent from every publishable blob: [redacted string $((++cn))]"
      else bad "still present in $hits blob(s): [redacted string $((++cn))]"; failures=$((failures + 1)); fi
    done < "$REDACT_FILE"
  fi

  # 3. Content neutrality. No dropped path sits at any branch tip, so every rewritten
  #    tip must hash to exactly the tree it replaced. Compared across repos by reading
  #    each side independently.
  local drifted=0 total=0 missing=0 branch before after tipfiles redacted canary
  while read -r branch; do
    [ -n "$branch" ] || continue
    total=$((total + 1))
    before=$(git -C "$BACKUP" rev-parse "refs/heads/$branch^{tree}" 2>/dev/null || echo MISSING-BEFORE)
    after=$(git -C "$MIRROR" rev-parse "refs/heads/$branch^{tree}" 2>/dev/null || echo MISSING-AFTER)
    if [ "$after" = "MISSING-AFTER" ]; then
      bad "branch lost in rewrite: $branch"; missing=$((missing + 1)); continue
    fi
    if [ "$before" != "$after" ]; then
      # Legitimate only if the tip carried a dropped path, or held a string the
      # redaction rewrote. Anything else means the rewrite touched work it should not.
      tipfiles=$(git -C "$BACKUP" ls-tree -r --name-only "refs/heads/$branch" -- "${PATHS_TO_DROP[@]}" 2>/dev/null | grep -c . || true)
      redacted=0
      if [ "$tipfiles" = "0" ] && [ -f "$REDACT_FILE" ]; then
        while IFS= read -r canary; do
          [ -n "$canary" ] || continue
          if git -C "$BACKUP" grep -q -a -F -- "$canary" "refs/heads/$branch" 2>/dev/null; then
            redacted=1; break
          fi
        done < "$REDACT_FILE"
      fi
      if [ "$tipfiles" = "0" ] && [ "$redacted" = "0" ]; then
        bad "$branch: tip tree changed ($before -> $after) with no dropped path and nothing redacted"
        drifted=$((drifted + 1))
      elif [ "$redacted" = "1" ]; then
        ok "$branch: tip tree changed because a redacted string was rewritten out"
      fi
    fi
  done < <(git -C "$BACKUP" for-each-ref --format='%(refname:strip=2)' refs/heads)

  if [ "$missing" = "0" ]; then ok "all $total branches survived the rewrite"
  else failures=$((failures + 1)); fi
  if [ "$drifted" = "0" ]; then ok "every branch tip tree is byte-identical to its pre-scrub tree"
  else failures=$((failures + 1)); fi

  # 4. Every commit the rewrite DROPPED must be justified. git-filter-repo's commit-map
  #    is authoritative: old sha -> new sha, or all-zeros when the commit went away.
  #    A dropped commit is legitimate only if its whole change was inside the dropped
  #    paths, or it is a merge that became empty once its payload left.
  local map="$MIRROR/filter-repo/commit-map"
  if [ ! -f "$map" ]; then
    bad "no commit-map at $map; cannot audit what was dropped"
    failures=$((failures + 1))
  else
    local dropped=0 unexplained=0 c parents total_files dropped_files
    while read -r c; do
      [ -n "$c" ] || continue
      dropped=$((dropped + 1))
      # Dropped commits may be gone from the mirror; the backup still has them.
      parents=$(git -C "$BACKUP" rev-list --parents -n1 "$c" 2>/dev/null | wc -w | tr -d ' ')
      total_files=$(git -C "$BACKUP" log -1 --format= --name-only "$c" 2>/dev/null | grep -c . || true)
      dropped_files=0
      while read -r f; do
        [ -n "$f" ] || continue
        if is_dropped_path "$f"; then dropped_files=$((dropped_files + 1)); fi
      done < <(git -C "$BACKUP" log -1 --format= --name-only "$c" 2>/dev/null)
      if [ "$parents" -gt 2 ]; then
        : # a merge that went empty
      elif [ "$total_files" -gt 0 ] && [ "$total_files" = "$dropped_files" ]; then
        : # confined to the dropped paths
      else
        bad "dropped a commit that was not confined to the dropped paths: $c"
        unexplained=$((unexplained + 1))
      fi
    done < <(awk 'NR>1 && $2 ~ /^0+$/ {print $1}' "$map")
    if [ "$unexplained" = "0" ]; then
      ok "all $dropped dropped commits were research-only or merges that went empty"
    else
      failures=$((failures + 1))
    fi
  fi

  [ "$failures" = "0" ] || die "$failures check(s) failed. Nothing pushed. Do not push."
  say "All checks passed."
}

# Read-only. Mirror-clones GitHub afresh and scans EVERY ref it serves, pull
# request heads included: those are public and no push can rewrite them.
verify_remote() {
  local check="$WORK_ROOT/verify-remote.git"
  [ -e "$check" ] && trash "$check"
  git clone --quiet --mirror "$REMOTE_URL" "$check"
  local branch_hits pull_refs=0 ref
  branch_hits=$(git -C "$check" log --branches --tags --oneline -- "${PATHS_TO_DROP[@]}" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$branch_hits" = "0" ]; then ok "no branch or tag reaches a commit touching: ${PATHS_TO_DROP[*]}"
  else bad "$branch_hits commits on branches or tags still touch the dropped paths"; fi
  while IFS= read -r ref; do
    if [ -n "$(git -C "$check" rev-list -1 "$ref" -- "${PATHS_TO_DROP[@]}")" ]; then
      pull_refs=$((pull_refs + 1))
    fi
  done < <(git -C "$check" for-each-ref --format='%(refname)' refs/pull)
  if [ "$pull_refs" = "0" ]; then ok "no pull request ref reaches one either"
  else bad "$pull_refs pull request refs still reach commits touching the dropped paths"; fi
  if [ "$branch_hits" != "0" ] || [ "$pull_refs" != "0" ]; then
    die "GitHub still serves the dropped paths. Branches and tags: re-run push.
Pull request refs: no push can rewrite them; ask GitHub Support to purge them.
Keep the repository private until this check passes."
  fi
}

cmd_prepare() {
  require_tools
  mkdir -p "$WORK_ROOT"

  # A mirror from an older run may carry imported pre-scrub refs. Never reuse one.
  [ -e "$MIRROR" ] && die "$MIRROR exists. trash '$MIRROR' and re-run, so the rewrite starts clean."

  if [ -e "$BACKUP" ]; then
    say "Refreshing the backup at $BACKUP"
    # Never just reuse it: a backup a few commits behind the remote makes the
    # tip-tree comparison compare two different things and report false drift.
    git -C "$BACKUP" fetch --prune "$REMOTE_URL" '+refs/heads/*:refs/heads/*'
    ok "backup holds $(git -C "$BACKUP" for-each-ref refs/heads | wc -l | tr -d ' ') branches"
  else
    say "Backing up the published history (insurance, never pushed)"
    git clone --mirror "$REMOTE_URL" "$BACKUP"
    ok "backup at $BACKUP"
  fi

  say "Cloning a fresh mirror to rewrite"
  git clone --mirror "$REMOTE_URL" "$MIRROR"

  say "Rewriting: dropping ${PATHS_TO_DROP[*]} from every commit on every ref"
  local args=() p
  for p in "${PATHS_TO_DROP[@]}"; do args+=(--path "$p"); done
  args+=(--invert-paths)
  if [ -f "$REDACT_FILE" ]; then
    # Also rewrite the sensitive strings out of blobs OUTSIDE the dropped paths.
    # --invert-paths applies to --path only; --replace-text is independent of it.
    args+=(--replace-text "$REDACT_FILE")
    ok "redacting $(grep -c . "$REDACT_FILE") string(s) from every blob, per $REDACT_FILE"
  else
    die "No redact/canary file at $REDACT_FILE. Write one line per sensitive string
(never inside the repo), then re-run. It drives both the redaction and the canary check."
  fi
  git -C "$MIRROR" filter-repo "${args[@]}"

  verify_mirror

  cat <<EOF

Prepared, not pushed. Nothing on GitHub has changed.

  rewritten mirror : $MIRROR
  backup (keep)    : $BACKUP

Commits the rewrite removed, from git-filter-repo's own commit-map:

$(awk 'NR>1 && $2 ~ /^0+$/ {print $1}' "$MIRROR/filter-repo/commit-map" \
  | while read -r c; do printf '    %s\n' "$(git -C "$BACKUP" log -1 --format='%h %s' "$c" 2>/dev/null || echo "$c (unreachable)")"; done)

Look for yourself before pushing:

  git -C "$MIRROR" log --branches --oneline -- ${PATHS_TO_DROP[*]}   # must print nothing
  git -C "$MIRROR" log --oneline master | head

Then:

  $0 push

EOF
}

cmd_push() {
  require_tools
  [ -d "$MIRROR" ] || die "No rewritten mirror at $MIRROR. Run '$0 prepare' first."
  [ -d "$BACKUP" ] || die "No backup at $BACKUP. Run '$0 prepare' first."

  verify_mirror

  local nheads ntags
  nheads=$(git -C "$MIRROR" for-each-ref --format='%(refname)' refs/heads | wc -l | tr -d ' ')
  ntags=$(git -C "$MIRROR" for-each-ref --format='%(refname)' refs/tags | wc -l | tr -d ' ')

  cat <<EOF

About to force-push the rewritten history over:

  $REMOTE_URL
  $nheads branches and $ntags tags. Every sha on the remote changes.

Heads and tags only, by explicit refspec. Not --mirror: a mirror clone also holds
refs/pull/*, which GitHub refuses, and --mirror pushes every ref it finds.

Consequences, none of them reversible from GitHub's side:
  - Every merged PR loses its commit links. GitHub will report those commits as
    belonging to no branch. Titles, descriptions and review threads live.
  - Every existing clone and Conductor worktree still holds the old history. Pushing
    from one afterwards puts the research straight back. Re-clone before you do.
  - The pre-scrub history then exists only at $BACKUP.

EOF
  printf 'Type exactly "scrub" to proceed: '
  read -r answer
  [ "$answer" = "scrub" ] || die "Aborted. Nothing pushed."

  git -C "$MIRROR" push --force "$REMOTE_URL" 'refs/heads/*:refs/heads/*'
  if [ "$ntags" != "0" ]; then
    git -C "$MIRROR" push --force "$REMOTE_URL" 'refs/tags/*:refs/tags/*'
  fi

  say "Pushed. Re-cloning from GitHub to confirm the remote is actually clean"
  verify_remote

  cat <<EOF

Done. In order:
  1. Re-clone for future work; existing checkouts hold the old history:
       git clone $REMOTE_URL ~/pleach-fresh
  2. Keep $BACKUP until you are sure nothing was lost.
  3. Only then consider making the repository public.

EOF
}

case "${1:-}" in
  prepare) cmd_prepare ;;
  push)    cmd_push ;;
  verify-remote) verify_remote ;;
  *)       echo "usage: $0 prepare|push|verify-remote" >&2; exit 2 ;;
esac
