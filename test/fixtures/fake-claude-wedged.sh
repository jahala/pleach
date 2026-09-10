#!/usr/bin/env bash
# Fake `claude` binary that never finishes a turn.
#
# It accepts prompts and records them, then goes quiet forever: no assistant
# entry with a stop_reason, no Stop hook. `umbel wait` therefore blocks until
# something outside the worker interrupts it — which is what the abort test
# needs to prove.
#
# Env vars (same contract as fake-claude.sh):
#   UMBEL_SESSION_ID      passed by umbel when launching
#   FAKE_CLAUDE_JSONL_DIR optional, write JSONL here instead of ~/.claude/projects/...

set -euo pipefail

SESSION_ID="${UMBEL_SESSION_ID:-fake-session}"

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
  # Record the prompt as a user turn, then produce nothing further — ever.
  printf '{"type":"human","message":{"role":"user","content":[{"type":"text","text":"prompt"}]},"uuid":"u-%s","timestamp":"%s"}\n' \
    "$$" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" >> "$JSONL_FILE"
done

# stdin closed and still nothing to say: stay alive so the session does not die.
while true; do sleep 3600; done
