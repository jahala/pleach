#!/bin/bash
# check-brand-drift.sh — Compare local .brand/ version against a central source.
#
# Two modes:
#   CLI mode:    check-brand-drift.sh <local-version> <source-path>
#   Config mode: check-brand-drift.sh [--petalrc <path>]
#
# Exit codes: 0=current, 1=drift, 2=unreachable, 3=no config, 4=ahead

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
  source "$SCRIPT_DIR/lib/common.sh"
  ROOT=$(find_project_root) && cd "$ROOT"
fi
PETALRC=".petalsrc"
LOCAL_ARG=""
SOURCE_ARG=""
CLI_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --petalrc) PETALRC="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: CLI mode: check-brand-drift.sh <local-version> <source-path>"
      echo "       Config mode: check-brand-drift.sh [--petalrc <path>]"
      exit 0 ;;
    -*)
      echo "Unknown flag: $1" >&2; exit 1 ;;
    *)
      if [[ -z "$LOCAL_ARG" ]]; then LOCAL_ARG="$1"
      elif [[ -z "$SOURCE_ARG" ]]; then SOURCE_ARG="$1"
      fi
      shift ;;
  esac
done

[[ -n "$LOCAL_ARG" && -n "$SOURCE_ARG" ]] && CLI_MODE=true

log()   { echo "[drift-check] $*" >&2; }
err()   { echo "[drift-check] ERROR: $*" >&2; }
json_out() { printf '{"local_version":"%s","central_version":"%s","status":"%s","message":"%s"}\n' "$1" "$2" "$3" "$4"; }

# ── Helper: get version from local .brand/identity.md ────────────────────────

get_local_version() {
  local dir="$1"
  local idfile="$dir/.brand/identity.md"
  if [[ -f "$idfile" ]]; then
    local v=$(grep -iE 'Brand Version' "$idfile" 2>/dev/null | head -1 | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    [[ -n "$v" ]] && { echo "$v"; return 0; }
  fi
  return 1
}

# ── CLI mode ─────────────────────────────────────────────────────────────────

if $CLI_MODE; then
  LOCAL_VERSION="$LOCAL_ARG"
  SOURCE="$SOURCE_ARG"
  log "CLI mode: local=$LOCAL_VERSION, source=$SOURCE"

  CENTRAL_VERSION=$(get_local_version "$SOURCE" || echo "")

  if [[ -z "$CENTRAL_VERSION" ]]; then
    json_out "$LOCAL_VERSION" "" "unreachable" \
      "Cannot reach brand source ($SOURCE). Local .brand/ at $LOCAL_VERSION preserved unchanged."
    exit 2
  fi

  log "Central version: $CENTRAL_VERSION"
  local_v="${LOCAL_VERSION#v}"; central_v="${CENTRAL_VERSION#v}"

  if [[ "$local_v" == "$central_v" ]]; then
    json_out "$LOCAL_VERSION" "$CENTRAL_VERSION" "current" "Brand is current."
    exit 0
  fi

  higher=$(printf '%s\n%s\n' "$local_v" "$central_v" | sort -V | tail -1)
  if [[ "$higher" == "$central_v" ]]; then
    json_out "$LOCAL_VERSION" "$CENTRAL_VERSION" "drift" \
      "Brand drift detected. Local: $LOCAL_VERSION. Central: $CENTRAL_VERSION. Run /petals update to sync."
    exit 1
  else
    json_out "$LOCAL_VERSION" "$CENTRAL_VERSION" "ahead" \
      "Local brand ($LOCAL_VERSION) is ahead of central ($CENTRAL_VERSION)."
    exit 4
  fi
fi

# ── Config mode: parse .petalsrc ──────────────────────────────────────────────

if [[ ! -f "$PETALRC" ]]; then
  json_out "" "" "no-source" "No .petalsrc found. Run /petals init --from <repo-url> first."
  exit 3
fi

SOURCE=$(grep -E '^[[:space:]]*source:' "$PETALRC" 2>/dev/null | head -1 | sed -E 's/^[[:space:]]*source:[[:space:]]*"?([^"#]+)"?.*/\1/' | xargs)
LOCAL_VERSION=$(grep -E '^[[:space:]]*version:' "$PETALRC" 2>/dev/null | head -1 | sed -E 's/^[[:space:]]*version:[[:space:]]*"?([^"#]+)"?.*/\1/' | xargs)

if [[ -z "$SOURCE" ]]; then
  json_out "${LOCAL_VERSION:-unknown}" "" "no-source" "No source in .petalsrc."
  exit 3
fi

LOCAL_VERSION="${LOCAL_VERSION:-unknown}"
log "Config mode: local=$LOCAL_VERSION, source=$SOURCE"

CENTRAL_VERSION=""
if [[ "$SOURCE" =~ ^/ ]] || [[ "$SOURCE" =~ ^\./ ]] || [[ "$SOURCE" =~ ^file:// ]]; then
  SOURCE_PATH="${SOURCE#file://}"
  CENTRAL_VERSION=$(get_local_version "$SOURCE_PATH" || echo "")
else
  log "Remote source: $SOURCE"
  if command -v git &>/dev/null; then
    CENTRAL_VERSION=$(git ls-remote --tags "$SOURCE" 2>/dev/null | grep -oE 'refs/tags/v?[0-9]+\.[0-9]+\.[0-9]+' | sed -E 's|refs/tags/||' | sort -V | tail -1 || echo "")
  fi
  if [[ -z "$CENTRAL_VERSION" ]] && [[ "$SOURCE" =~ github\.com ]]; then
    local owner_repo=$(echo "$SOURCE" | sed -E 's|^https?://github\.com/||; s|\.git$||; s|^git@github\.com:||; s|/$||')
    CENTRAL_VERSION=$(curl -s --max-time 10 "https://raw.githubusercontent.com/${owner_repo}/main/.brand/identity.md" 2>/dev/null | grep -iE 'Brand Version' | head -1 | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "")
  fi
fi

if [[ -z "$CENTRAL_VERSION" ]]; then
  json_out "$LOCAL_VERSION" "" "unreachable" \
    "Cannot reach brand source ($SOURCE). Local .brand/ at $LOCAL_VERSION preserved unchanged."
  exit 2
fi

log "Central version: $CENTRAL_VERSION"
local_v="${LOCAL_VERSION#v}"; central_v="${CENTRAL_VERSION#v}"

if [[ "$local_v" == "$central_v" ]]; then
  json_out "$LOCAL_VERSION" "$CENTRAL_VERSION" "current" "Brand is current."
  exit 0
fi

higher=$(printf '%s\n%s\n' "$local_v" "$central_v" | sort -V | tail -1)
if [[ "$higher" == "$central_v" ]]; then
  json_out "$LOCAL_VERSION" "$CENTRAL_VERSION" "drift" \
    "Brand drift detected. Local: $LOCAL_VERSION. Central: $CENTRAL_VERSION. Run /petals update to sync."
  exit 1
else
  json_out "$LOCAL_VERSION" "$CENTRAL_VERSION" "ahead" \
    "Local brand ($LOCAL_VERSION) is ahead of central ($CENTRAL_VERSION)."
  exit 4
fi
