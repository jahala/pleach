#!/usr/bin/env bash
# Test fixture: a land gate in the shape a garden's staleness check has
# (ledger D18). Its one argument is the base sha pleach substituted for
# `{base}` — the target branch's tip before the merge — and its cwd is the
# composed stack, so it can ask the only question that matters: does what this
# landing changes touch a claim someone already stamped?
#
# The stamped paths are a plain file, `.stamps`, read from the stack it runs
# in — the same shape as `tend2 gate --base`, minus the map. A gate that cannot
# answer refuses (exit 2) rather than passing by default.
set -euo pipefail

base="${1:?usage: land-gate.sh <base-sha>}"

if [ ! -f .stamps ]; then
  echo "land-gate: no .stamps in $(pwd) — nothing to check against" >&2
  exit 2
fi

# --no-renames: a rename IS a move of the evidence, and rename detection would
# report only where the file went, never the stamped path it left.
changed=$(git diff --no-renames --name-only "$base" HEAD)

status=0
while IFS= read -r stamped; do
  [ -n "$stamped" ] || continue
  if printf '%s\n' "$changed" | grep -qxF -- "$stamped"; then
    echo "stale stamp: $stamped" >&2
    status=1
  fi
done < .stamps

if [ "$status" -eq 0 ]; then
  echo "land-gate: no stamped path changed since $base"
fi
exit "$status"
