#!/usr/bin/env bash
# canary.sh — the tend2 × pleach integration canary (joint decision sheet #8).
#
# Proves the pair users actually get: a plan EMITTED BY TEND2's real CLI runs
# through pleach's real CLI to a verified close on plain git. Deterministic by
# construction — the fixture's single node is command-work and the gate is
# tend2's own verifier, so no agent, no API key, no subscription; CI-safe.
#
# The vendored emission + fixture live at test/canary/ (provided by tend2's
# CANARY-0; their CI byte-diffs fresh emissions against this artifact, so
# emission drift goes red on THEIR side before a stale artifact reaches us).
#
# tend2 CLI resolution: $PLEACH_CANARY_TEND2 (full invocation, e.g.
# "node /path/to/dist/cli.js"), else `tend2` on PATH (post-#49).
# Unresolvable → SKIP (exit 0) locally, RED (exit 1) when CI=true: a green CI
# run that checked nothing is no canary (ledger D25).
#
# Failure protocol (agreed on-channel 2026-08-17): a red canary BLOCKS both
# release lanes and gets reported on the walkie channel.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PLAN="$ROOT/test/canary/emitted-plan.json"
FIXTURE="$ROOT/test/canary/fixture"

if [ ! -f "$PLAN" ]; then
  echo "canary: SKIP — no vendored emission at test/canary/emitted-plan.json" >&2
  exit 0
fi

VERIFY_BIN="${PLEACH_CANARY_TEND2:-}"
if [ -z "$VERIFY_BIN" ] && command -v tend2 > /dev/null 2>&1; then
  VERIFY_BIN="tend2"
fi
if [ -z "$VERIFY_BIN" ]; then
  if [ "${CI:-}" = "true" ]; then
    echo "canary: RED — no tend2 CLI on a CI run (set PLEACH_CANARY_TEND2 or put tend2 on PATH)" >&2
    exit 1
  fi
  echo "canary: SKIP — no tend2 CLI (set PLEACH_CANARY_TEND2 or install tend2)" >&2
  exit 0
fi

REPO="$(mktemp -d -t pleach-canary.XXXXXX)"
trap 'rm -rf "$REPO" 2>/dev/null || true' EXIT

cp -R "$FIXTURE/." "$REPO/"
git -C "$REPO" init -q
git -C "$REPO" add -A
git -C "$REPO" -c user.email=canary@pleach -c user.name=canary commit -qm 'seed: canary fixture'

# Substitute the machine-local verifier invocation into the emitted plan.
RESOLVED_PLAN="$REPO/.canary-plan.json"
sed "s|{{VERIFY_BIN}}|$VERIFY_BIN|g" "$PLAN" > "$RESOLVED_PLAN"

echo "canary: validate" >&2
bun "$ROOT/src/main.ts" validate "$RESOLVED_PLAN" > /dev/null

echo "canary: run (verifier: $VERIFY_BIN)" >&2
bun "$ROOT/src/main.ts" run "$RESOLVED_PLAN" --repo-root "$REPO" > /tmp/pleach-canary-summary.json

FAILED=$(jq -r '.failed | length' /tmp/pleach-canary-summary.json)
CLOSED=$(jq -r '.closed | length' /tmp/pleach-canary-summary.json)
if [ "$FAILED" != "0" ] || [ "$CLOSED" = "0" ]; then
  echo "canary: RED — closed=$CLOSED failed=$FAILED (summary: /tmp/pleach-canary-summary.json)" >&2
  exit 1
fi

BRANCHES=$(git -C "$REPO" for-each-ref --format='%(refname:short)' refs/heads/node/ | wc -l | tr -d ' ')
if [ "$BRANCHES" = "0" ]; then
  echo "canary: RED — no node/* branches published" >&2
  exit 1
fi

echo "canary: GREEN — $CLOSED node(s) closed, $BRANCHES branch(es) published" >&2
