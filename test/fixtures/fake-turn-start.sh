# Sourced by the fake claude workers (fake-claude*.sh) with their own "$@".
#
# umbel passes its hook config inline in `--settings`. Since umbel 9986796
# (umbel#121) a `send` waits for the registered UserPromptSubmit hook to fire
# and exits 1 when no turn starts within 10 s. A fake standing in for claude
# honours that hook the way the binary does: once per submitted prompt, with
# the session's id, transcript path and cwd on its stdin.
TURN_START_HOOK=''
_prev=''
for _arg in "$@"; do
  if [[ "$_prev" == "--settings" ]]; then
    TURN_START_HOOK=$(printf '%s' "$_arg" | jq -r '.hooks.UserPromptSubmit[0].hooks[0].command // empty' 2>/dev/null || true)
  fi
  _prev="$_arg"
done

fire_turn_start() {
  if [[ -n "${TURN_START_HOOK:-}" ]]; then
    printf '{"session_id":"%s","transcript_path":"%s","cwd":"%s","hook_event_name":"UserPromptSubmit"}' \
      "${SESSION_ID}" "${JSONL_FILE}" "$(pwd)" | bash "${TURN_START_HOOK}"
  fi
}
