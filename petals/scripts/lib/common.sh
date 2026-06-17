#!/usr/bin/env bash
# petals/scripts/lib/common.sh — shared helpers for all petals scripts.

# Walk up from a directory (default: $PWD) looking for the project root.
# A project root is a directory containing .petalsrc or .brand/.
# Prints the absolute path and returns 0, or returns 1 if not found.
find_project_root() {
  local dir="${1:-$PWD}"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/.petalsrc" ]] || [[ -d "$dir/.brand" ]]; then
      echo "$dir"
      return 0
    fi
    dir=$(dirname "$dir")
  done
  return 1
}
