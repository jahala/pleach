#!/usr/bin/env bash
# Proof 1 — the strict rig (umbel + git + a standalone discriminating audit; NO tend).
#
# umbel drives claude (build) + codex (audit) interactively in tmux; gitLedger records the
# verified close as node/* branches. The audit is payload/project/strict-audit.sh — tend's
# negctrl (break the source, a passing test must then fail) in ~20 lines, so no tend
# instance is needed. Same web-game plan as every profile; only the runner + the audit's
# strictness differ. tend is the production verifier — see docs/research/proof-run.md.
#
# Requires: umbel + claude + codex on PATH (logged in) - bun - git - jq. NO tend.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PAYLOAD="$(cd "$HERE/../payload" && pwd)"
PLEACH_ROOT="$(cd "$HERE/../../.." && pwd)"

REPO="$(mktemp -d -t three-ways-umbel.XXXXXX)"
echo "[setup] fresh repo at $REPO" >&2
cp -R "$PAYLOAD/project/." "$REPO/"
git -C "$REPO" init -q
git -C "$REPO" add -A
git -C "$REPO" commit -qm "seed: ttt project"

# Same canonical web-game plan as the other profiles, with the audit swapped to the
# discriminating strict-audit.sh (the negctrl) — proof 1 is the strict rig.
jq '(.nodes[] | select(.id == "ttt").accept.audit.command) = "bash strict-audit.sh ttt"' \
  "$PAYLOAD/plan.json" > "$REPO/plan.json"

echo "[run] umbel: claude builds, codex runs the discriminating audit" >&2
bun "$PLEACH_ROOT/src/main.ts" run "$REPO/plan.json" \
  --config "$HERE/pleach.config.ts" \
  --repo-root "$REPO" \
  --max-concurrency 2

echo "" >&2
echo "[done] verified branches:" >&2
git -C "$REPO" branch --list 'node/*' >&2
