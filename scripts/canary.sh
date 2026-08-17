#!/usr/bin/env bash
# canary.sh — the tend2 × pleach integration canary (joint decision sheet #8).
#
# Proves the pair users actually get: a plan EMITTED BY TEND2 runs through
# pleach to a verified close on plain git. Deterministic by construction — the
# canary fixture uses command-work nodes only, so no agent, no API key, no
# subscription is ever needed; CI-safe.
#
# Two halves, per the agreed division:
#   - tend2's CI validates fresh emissions against the vendored schema.
#   - THIS script runs the canonical emitted plan through pleach's real CLI.
# The vendored emission lives at test/canary/emitted-plan.json (provided by
# tend2 from its emitter; re-vendored whenever their emitter changes shape).
#
# Failure protocol (agreed on-channel 2026-08-17): a red canary BLOCKS both
# release lanes and gets reported on the walkie channel. A canary nobody gates
# on is theater.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PLAN="$ROOT/test/canary/emitted-plan.json"

if [ ! -f "$PLAN" ]; then
  echo "canary: SKIP — no vendored emission at test/canary/emitted-plan.json yet" >&2
  echo "canary: (tend2 provides the canonical command-work emission; requested on-channel)" >&2
  exit 0
fi

REPO="$(mktemp -d -t pleach-canary.XXXXXX)"
trap 'rm -rf "$REPO" 2>/dev/null || true' EXIT
git -C "$REPO" init -q
git -C "$REPO" -c user.email=canary@pleach -c user.name=canary commit -q --allow-empty -m seed

echo "canary: validate" >&2
bun "$ROOT/src/main.ts" validate "$PLAN" > /dev/null

echo "canary: run" >&2
bun "$ROOT/src/main.ts" run "$PLAN" --repo-root "$REPO" > /tmp/pleach-canary-summary.json

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
