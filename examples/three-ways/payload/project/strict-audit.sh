#!/usr/bin/env bash
# strict-audit.sh — a standalone DISCRIMINATING audit: tend's negctrl, without tend.
#
# A green suite isn't proof — a tautological test passes too. So after the suite goes
# green, this runs a NEGATIVE CONTROL: it breaks the engine (winner() always returns
# null) and re-runs. A suite that DISCRIMINATES must now go red. If it stays green the
# tests don't pin the behaviour -> the honest middle (partial), not a pass. The source
# is always restored (trap), so the disposable worktree is left pristine.
#
# This is what tend does at the ledger, in ~20 lines, so proof 1 needs no tend instance.
# tend is the production-grade version — see docs/research/proof-run.md.
set -uo pipefail
check="${1:-ttt}"
emit() { printf '```tend-audit-result\n%s\n```\n' "$1"; }

# 1. Baseline — the suite must pass.
if ! bun test >/tmp/strict-audit-base.log 2>&1; then
  emit "{\"verdicts\":[{\"check\":\"${check}\",\"verdict\":\"fail\",\"reasons\":[\"test suite failed\"],\"negctrl\":{\"ran\":false,\"discriminated\":false}}],\"drift\":[]}"
  exit 0
fi

# 2. Negative control — break winner(); a discriminating suite must now fail.
orig="$(mktemp)"
cp src/ttt.ts "$orig"
trap 'cp "$orig" src/ttt.ts 2>/dev/null' EXIT
perl -0pi -e 's/(export function winner\([^)]*\)[^{]*\{)/$1\n  return null;/' src/ttt.ts
if bun test >/tmp/strict-audit-neg.log 2>&1; then
  discriminated=false
else
  discriminated=true
fi
cp "$orig" src/ttt.ts
trap - EXIT

# 3. Verdict — pass ONLY if the suite passed AND discriminated.
if $discriminated; then
  emit "{\"verdicts\":[{\"check\":\"${check}\",\"verdict\":\"pass\",\"reasons\":[],\"negctrl\":{\"ran\":true,\"discriminated\":true}}],\"drift\":[]}"
else
  emit "{\"verdicts\":[{\"check\":\"${check}\",\"verdict\":\"partial\",\"reasons\":[\"negctrl: a broken winner() still passed — tests do not discriminate\"],\"negctrl\":{\"ran\":true,\"discriminated\":false}}],\"drift\":[]}"
fi
