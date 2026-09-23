#!/usr/bin/env bash
# Fake `claude` binary that answers once and then goes quiet forever.
#
# On each prompt it writes a file into its cwd (the node's worktree — so a
# quarantine has work to keep), prints one line to the pane, and records the
# prompt as a user turn. Then nothing, ever: no assistant entry with a
# stop_reason, no Stop hook, no further pane output. Only an idle timeout can
# end the wait; without one it rides the attempt clock to its hard deadline.
#
# The wedged sibling (fake-claude-wedged.sh) never writes and never prints —
# it stands for a worker that produced nothing. This one stands for the wedged
# worker that HAD started work when it went silent.
#
# Env vars (same contract as fake-claude.sh):
#   UMBEL_SESSION_ID      passed by umbel when launching
#   FAKE_CLAUDE_JSONL_DIR optional, write JSONL here instead of ~/.claude/projects/...
#   FAKE_CLAUDE_IDLE_FILE optional, the file written in cwd (default idle-work.txt)

set -euo pipefail

SESSION_ID="${UMBEL_SESSION_ID:-fake-session}"
WORK_FILE="${FAKE_CLAUDE_IDLE_FILE:-idle-work.txt}"

if [[ -n "${FAKE_CLAUDE_JSONL_DIR:-}" ]]; then
  mkdir -p "${FAKE_CLAUDE_JSONL_DIR}"
  JSONL_FILE="${FAKE_CLAUDE_JSONL_DIR}/${SESSION_ID}.jsonl"
else
  ENCODED_CWD="$(echo -n "$(pwd)" | sed 's/[^a-zA-Z0-9]/-/g')"
  JSONL_FILE="${HOME}/.claude/projects/${ENCODED_CWD}/${SESSION_ID}.jsonl"
  mkdir -p "$(dirname "$JSONL_FILE")"
fi

# Touch immediately so umbel's session-jsonl discovery finds the transcript.
touch "${JSONL_FILE}"

while IFS= read -r line || [[ -n "${line:-}" ]]; do
  [[ "${line:-}" == "/exit" ]] && exit 0
  # Work started: a file in the tree, one line in the pane. Written once and
  # renamed into place, never truncated again: umbel's kill closes stdin, which
  # runs this body one last time while pleach snapshots the tree, and a
  # truncate-then-write there could leave the snapshot an empty file (D25).
  if [[ ! -e "${WORK_FILE}" ]]; then
    printf 'started work\n' > "${WORK_FILE}.tmp"
    mv "${WORK_FILE}.tmp" "${WORK_FILE}"
  fi
  printf 'working on it\n'
  # Record the prompt as a user turn, then produce nothing further — ever.
  printf '{"type":"human","message":{"role":"user","content":[{"type":"text","text":"prompt"}]},"uuid":"u-%s","timestamp":"%s"}\n' \
    "$$" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" >> "$JSONL_FILE"
done

# stdin closed and still nothing to say: stay alive so the session does not die.
while true; do sleep 3600; done
