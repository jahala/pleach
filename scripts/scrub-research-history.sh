#!/usr/bin/env bash
# scrub-research-history.sh — remove private paths from pleach's published history.
#
# WHY: docs/research/ was tracked on master from 2026-06-18 until commit 2bd65bc
# deleted it. Seven files survive in history and are reachable from master and from
# 49 of the 50 remote branches: candid competitor analysis naming real companies and
# their production failures, an internal whole-project audit, and a verbatim dialogue
# archive. Flipping the repository to public publishes all of it. After the flip it is
# in GitHub's caches, in forks, and in archives, so the scrub has to happen first.
#
# Run `prepare` first. It touches nothing published: it takes a backup, rewrites a
# throwaway mirror, and proves the result against the backup. Read its report, then
# run `push`.
#
#   scripts/scrub-research-history.sh prepare
#   scripts/scrub-research-history.sh push
#
# Requires git-filter-repo (brew install git-filter-repo), trash, and gh auth.

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

# Strings that appear only inside docs/research/. Verified 2026-09-20 against all 1336
# blobs on every branch and remote: zero hits outside docs/research/. They are the
# content-level proof that the scrub worked, independent of any path check. Add a
# canary for any path added to PATHS_TO_DROP above.
CANARIES=("***REMOVED***" "***REMOVED***" "***REMOVED***")

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

# Refuses the push unless the rewrite is both complete and content-neutral.
verify_mirror() {
  local failures=0
  say "Verifying $MIRROR against $BACKUP"

  # The backup is the only honest reference for "what did this look like before".
  git -C "$MIRROR" remote remove backup 2>/dev/null || true
  git -C "$MIRROR" remote add backup "$BACKUP"
  git -C "$MIRROR" fetch --quiet backup 'refs/heads/*:refs/backup/*'

  # 1. No commit on any ref still touches the dropped paths.
  local path_hits
  path_hits=$(git -C "$MIRROR" log --all --oneline -- "${PATHS_TO_DROP[@]}" 2>/dev/null \
    | wc -l | tr -d ' ')
  if [ "$path_hits" = "0" ]; then ok "no commit on any ref touches: ${PATHS_TO_DROP[*]}"
  else bad "$path_hits commits still touch the dropped paths"; failures=$((failures + 1)); fi

  # 2. No blob anywhere still carries the content. A path filter misses a copy that
  #    was ever committed under a different name, so check the bytes, not the path.
  local blobs
  blobs=$(git -C "$MIRROR" rev-list --all --objects \
    | awk '{print $1}' | sort -u \
    | git -C "$MIRROR" cat-file --batch-check='%(objectname) %(objecttype)' 2>/dev/null \
    | awk '$2=="blob" {print $1}')
  ok "scanning $(printf '%s\n' "$blobs" | wc -l | tr -d ' ') blobs for canaries"
  local canary hits
  for canary in "${CANARIES[@]}"; do
    hits=$(printf '%s\n' "$blobs" | git -C "$MIRROR" cat-file --batch 2>/dev/null \
      | grep -a -c -- "$canary" || true)
    if [ "$hits" = "0" ]; then ok "absent from every blob: \"$canary\""
    else bad "still present in $hits blob(s): \"$canary\""; failures=$((failures + 1)); fi
  done

  # 3. Content neutrality, branch by branch. Every difference between the backup tip
  #    and the rewritten tip must be a deletion under a dropped path. Anything else —
  #    a modification, a deletion elsewhere, an addition — means the rewrite altered
  #    work it had no business touching, and the push must not happen.
  local drifted=0 total=0 missing=0 branch line status path
  while read -r branch; do
    [ -n "$branch" ] || continue
    total=$((total + 1))
    if ! git -C "$MIRROR" rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
      bad "branch lost in rewrite: $branch"; missing=$((missing + 1)); continue
    fi
    while IFS=$'\t' read -r status path; do
      [ -n "$status" ] || continue
      if [ "$status" != "D" ] || ! is_dropped_path "$path"; then
        bad "$branch: unexpected change $status $path"
        drifted=$((drifted + 1))
      fi
    done < <(git -C "$MIRROR" diff --name-status \
               "refs/backup/$branch" "refs/heads/$branch")
  done < <(git -C "$MIRROR" for-each-ref --format='%(refname:strip=2)' refs/backup)

  if [ "$missing" = "0" ]; then ok "all $total branches survived the rewrite"
  else failures=$((failures + 1)); fi
  if [ "$drifted" = "0" ]; then
    ok "every branch tip differs only by deletions under the dropped paths"
  else failures=$((failures + 1)); fi

  # 4. Commit pruning is exactly the commits that held nothing else. Derived from the
  #    backup, not hardcoded, so it stays honest if PATHS_TO_DROP changes.
  local expected_pruned=0 c tot res
  for c in $(git -C "$MIRROR" rev-list refs/backup/master -- "${PATHS_TO_DROP[@]}"); do
    tot=$(git -C "$MIRROR" show --name-only --format= "$c" | grep -c . || true)
    res=0
    while read -r path; do
      [ -n "$path" ] || continue
      is_dropped_path "$path" && res=$((res + 1))
    done < <(git -C "$MIRROR" show --name-only --format= "$c")
    [ "$tot" = "$res" ] && expected_pruned=$((expected_pruned + 1))
  done
  local before after actual
  before=$(git -C "$MIRROR" rev-list refs/backup/master --count)
  after=$(git -C "$MIRROR" rev-list refs/heads/master --count)
  actual=$((before - after))
  if [ "$actual" = "$expected_pruned" ]; then
    ok "master $before -> $after commits; exactly the $expected_pruned that held nothing else"
  else
    bad "master lost $actual commits, expected to lose $expected_pruned"
    failures=$((failures + 1))
  fi

  [ "$failures" = "0" ] || die "$failures check(s) failed. Nothing pushed. Do not push."
  say "All checks passed."
}

cmd_prepare() {
  require_tools
  [ -e "$MIRROR" ] && die "$MIRROR exists. trash '$MIRROR' and re-run."
  mkdir -p "$WORK_ROOT"

  if [ -e "$BACKUP" ]; then
    say "Reusing the existing backup at $BACKUP"
  else
    say "Backing up the published history (insurance, never pushed)"
    git clone --mirror "$REMOTE_URL" "$BACKUP"
    ok "backup at $BACKUP"
  fi

  say "Cloning a fresh mirror to rewrite"
  git clone --mirror "$REMOTE_URL" "$MIRROR"

  say "Rewriting: dropping ${PATHS_TO_DROP[*]} from every commit on every ref"
  local args=()
  local p
  for p in "${PATHS_TO_DROP[@]}"; do args+=(--path "$p"); done
  git -C "$MIRROR" filter-repo "${args[@]}" --invert-paths

  verify_mirror

  cat <<EOF

Prepared, not pushed. Nothing on GitHub has changed.

  rewritten mirror : $MIRROR
  backup (keep)    : $BACKUP

Commits that held nothing but the dropped paths, and so are gone:

$(git -C "$MIRROR" log refs/backup/master --format='    %h %s' -- "${PATHS_TO_DROP[@]}")

Look for yourself before pushing:

  git -C "$MIRROR" log --all --oneline -- ${PATHS_TO_DROP[*]}   # must print nothing
  git -C "$MIRROR" diff refs/backup/master master               # must be deletions only

Then:

  $0 push

EOF
}

cmd_push() {
  require_tools
  [ -d "$MIRROR" ] || die "No rewritten mirror at $MIRROR. Run '$0 prepare' first."
  [ -d "$BACKUP" ] || die "No backup at $BACKUP. Run '$0 prepare' first."

  verify_mirror

  cat <<EOF

About to force-push the rewritten history over:

  $REMOTE_URL
  50 branches, master included. Every sha on the remote changes.

Consequences, none of them reversible from GitHub's side:
  - Every merged PR (#1-#122) loses its commit links. GitHub will report those
    commits as belonging to no branch. Titles, descriptions and review threads live.
  - Every existing clone and Conductor worktree still holds the old history. Pushing
    from one afterwards puts the research straight back. Re-clone before you do.
  - The pre-rewrite history then exists only at $BACKUP.

EOF
  printf 'Type exactly "scrub" to proceed: '
  read -r answer
  [ "$answer" = "scrub" ] || die "Aborted. Nothing pushed."

  git -C "$MIRROR" remote remove origin 2>/dev/null || true
  git -C "$MIRROR" remote add origin "$REMOTE_URL"
  git -C "$MIRROR" push --force --mirror origin

  say "Pushed. Re-cloning from GitHub to confirm the remote is actually clean"
  local check="$WORK_ROOT/verify-after-push.git"
  [ -e "$check" ] && trash "$check"
  git clone --mirror "$REMOTE_URL" "$check"
  local hits
  hits=$(git -C "$check" log --all --oneline -- "${PATHS_TO_DROP[@]}" 2>/dev/null \
    | wc -l | tr -d ' ')
  if [ "$hits" = "0" ]; then
    ok "GitHub's copy carries no commit touching: ${PATHS_TO_DROP[*]}"
  else
    die "GitHub still has $hits such commits. Do NOT make the repository public."
  fi

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
  *)       echo "usage: $0 prepare|push" >&2; exit 2 ;;
esac
