#!/usr/bin/env bash
# Proof 2 — bring your own runner (direct-CLI + git; no umbel, no tend).
#
# Builds the tic-tac-toe engine with real agents reached by a small, readable runner:
# `claude -p` for each build node, `codex exec` for the cross-provider audit. The
# verified close is recorded as node/* branches on plain git.
#
# Requires: claude + codex CLIs on PATH (logged in) - bun - git. NO umbel, NO tend.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PAYLOAD="$(cd "$HERE/../payload" && pwd)"
PLEACH_ROOT="$(cd "$HERE/../../.." && pwd)"

REPO="$(mktemp -d -t three-ways-direct-cli.XXXXXX)"
echo "[setup] fresh repo at $REPO" >&2
cp -R "$PAYLOAD/project/." "$REPO/"
git -C "$REPO" init -q
git -C "$REPO" add -A
git -C "$REPO" commit -qm "seed: ttt project"

echo "[run] claude builds, codex audits - headless, recorded on git" >&2
bun "$PLEACH_ROOT/src/main.ts" run "$PAYLOAD/plan.json" \
  --config "$HERE/pleach.config.ts" \
  --repo-root "$REPO" \
  --max-concurrency 2

echo "" >&2
echo "[done] verified branches:" >&2
git -C "$REPO" branch --list 'node/*' >&2
