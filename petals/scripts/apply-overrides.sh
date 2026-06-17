#!/bin/bash
# apply-overrides.sh — Merge .petalsrc overrides into .brand/ files.
#
# Reads the overrides map from .petalsrc and applies each non-null override
# to the corresponding .brand/ file. Null overrides are tracked but do not
# modify the file (they inherit from the central brand).
#
# Usage:
#   apply-overrides.sh [--petalrc <path>] [--brand <path>]
#
# Exit codes:
#   0 — overrides applied (or none to apply)
#   1 — error applying overrides
#
# Output (stdout): JSON with applied and skipped overrides.
# Output (stderr): operational logs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
  source "$SCRIPT_DIR/lib/common.sh"
  ROOT=$(find_project_root) && cd "$ROOT"
fi

PETALRC=".petalsrc"
BRAND_DIR=".brand"
APPLIED_COUNT=0
SKIPPED_COUNT=0
APPLIED_KEYS=()
SKIPPED_KEYS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --petalrc) PETALRC="$2"; shift 2 ;;
    --brand)   BRAND_DIR="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: apply-overrides.sh [--petalrc <path>] [--brand <path>]"
      exit 0 ;;
    *) shift ;;
  esac
done

log()   { echo "[apply-overrides] $*" >&2; }
err()   { echo "[apply-overrides] ERROR: $*" >&2; }

json_out() {
  local applied_json="["
  local first=true
  local entry
  for entry in "${APPLIED_KEYS[@]:-}"; do
    [[ -z "$entry" ]] && continue
    if $first; then first=false; else applied_json+=","; fi
    applied_json+="\"$entry\""
  done
  applied_json+="]"

  local skipped_json="["
  first=true
  for entry in "${SKIPPED_KEYS[@]:-}"; do
    [[ -z "$entry" ]] && continue
    if $first; then first=false; else skipped_json+=","; fi
    skipped_json+="\"$entry\""
  done
  skipped_json+="]"

  printf '{"applied_count":%d,"skipped_count":%d,"applied":%s,"skipped":%s}\n' \
    "$APPLIED_COUNT" "$SKIPPED_COUNT" "$applied_json" "$skipped_json"
}

# ── Parse overrides from .petalsrc ────────────────────────────────────────────

parse_overrides() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    log "No .petalsrc found at $file"
    return 1
  fi

  # Parse YAML overrides section. We look for lines between "overrides:" and the next
  # top-level or end-of-file, extracting "key: value" pairs.
  # Keys are dot-separated (e.g., colors.primary)
  local in_overrides=false
  local override_pairs=()

  while IFS= read -r line; do
    # Detect start of overrides block
    if echo "$line" | grep -qE '^[[:space:]]*overrides:'; then
      in_overrides=true
      continue
    fi

    if $in_overrides; then
      # Check if we've left the overrides block (dedented line or empty)
      if [[ "$line" =~ ^[[:space:]]{0,2}[a-zA-Z] ]] || [[ -z "${line// }" ]]; then
        if [[ ! "$line" =~ ^[[:space:]]{4,} ]] && [[ -n "${line// }" ]]; then
          # This is a new top-level key, exit overrides
          break
        fi
        if [[ -z "${line// }" ]]; then
          continue
        fi
      fi

      # Extract key: value from overrides entry
      # Pattern: "    key.path: value" or "    key.path: null"
      if echo "$line" | grep -qE '^[[:space:]]{4,}[a-zA-Z_.-]+:'; then
        local key val
        key=$(echo "$line" | sed -E 's/^[[:space:]]*([a-zA-Z_.-]+):.*$/\1/')
        val=$(echo "$line" | sed -E 's/^[[:space:]]*[a-zA-Z_.-]+:[[:space:]]*//' | sed -E "s/^(['\"])//;s/['\"]$//" | sed -E 's/[[:space:]]*$//')

        # Normalize null
        if [[ "$val" == "null" || "$val" == "~" || "$val" == "" ]]; then
          val="null"
        fi

        override_pairs+=("$key=$val")
      fi
    fi
  done < "$file"

  # Output pairs, one per line
  for pair in "${override_pairs[@]}"; do
    echo "$pair"
  done
}

# ── Override application ─────────────────────────────────────────────────────

# Apply override by in-place file editing
# This is a generic key-to-filesystem mapping. Each override key maps to a
# specific location in a specific .brand/ file.

apply_override_colors_primary() {
  local value="$1"
  local file="$BRAND_DIR/colors.md"

  if [[ ! -f "$file" ]]; then
    err "colors.md not found in $BRAND_DIR"
    return 1
  fi

  # Replace the primary hex in the palette table row
  # Pattern: | Primary | #XXXXXX | ...
  # Also replace in CSS custom property: --color-primary: #XXXXXX;
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' -E "s/(\| Primary \| )#[A-Fa-f0-9]{6}( \|.*)/\1${value}\2/" "$file"
    sed -i '' -E "s/(--color-primary: )#[A-Fa-f0-9]{6}(;)/\1${value}\2/" "$file"
  else
    sed -i -E "s/(\| Primary \| )#[A-Fa-f0-9]{6}( \|.*)/\1${value}\2/" "$file"
    sed -i -E "s/(--color-primary: )#[A-Fa-f0-9]{6}(;)/\1${value}\2/" "$file"
  fi
  log "  Applied colors.primary=$value in colors.md"
}

apply_override_colors_accent() {
  local value="$1"
  local file="$BRAND_DIR/colors.md"

  if [[ ! -f "$file" ]]; then
    err "colors.md not found in $BRAND_DIR"
    return 1
  fi

  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' -E "s/(\| Accent \| )#[A-Fa-f0-9]{6}( \|.*)/\1${value}\2/" "$file"
    sed -i '' -E "s/(--color-accent: )#[A-Fa-f0-9]{6}(;)/\1${value}\2/" "$file"
  else
    sed -i -E "s/(\| Accent \| )#[A-Fa-f0-9]{6}( \|.*)/\1${value}\2/" "$file"
    sed -i -E "s/(--color-accent: )#[A-Fa-f0-9]{6}(;)/\1${value}\2/" "$file"
  fi
  log "  Applied colors.accent=$value in colors.md"
}

apply_override_typography_heading() {
  local value="$1"
  local file="$BRAND_DIR/typography.md"

  if [[ ! -f "$file" ]]; then
    err "typography.md not found in $BRAND_DIR"
    return 1
  fi

  # Replace the heading font family in the Font Families table
  # Pattern: | Heading | FontName | Category |
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' -E "s/(\| Heading \| )[^|]+( \| [^|]+ \|)/\1${value}\2/" "$file"
  else
    sed -i -E "s/(\| Heading \| )[^|]+( \| [^|]+ \|)/\1${value}\2/" "$file"
  fi
  log "  Applied typography.heading=$value in typography.md"
}

apply_override_typography_body() {
  local value="$1"
  local file="$BRAND_DIR/typography.md"

  if [[ ! -f "$file" ]]; then
    err "typography.md not found in $BRAND_DIR"
    return 1
  fi

  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' -E "s/(\| Body \| )[^|]+( \| [^|]+ \|)/\1${value}\2/" "$file"
  else
    sed -i -E "s/(\| Body \| )[^|]+( \| [^|]+ \|)/\1${value}\2/" "$file"
  fi
  log "  Applied typography.body=$value in typography.md"
}

apply_override_typography_mono() {
  local value="$1"
  local file="$BRAND_DIR/typography.md"

  if [[ ! -f "$file" ]]; then
    err "typography.md not found in $BRAND_DIR"
    return 1
  fi

  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' -E "s/(\| Mono \| )[^|]+( \| [^|]+ \|)/\1${value}\2/" "$file"
  else
    sed -i -E "s/(\| Mono \| )[^|]+( \| [^|]+ \|)/\1${value}\2/" "$file"
  fi
  log "  Applied typography.mono=$value in typography.md"
}

# Override handler dispatch table — maps override keys to handler functions.
# Uses variable-indirection convention (bash 3.2 compatible).
# Handler for key X.Y is stored in OVERRIDE_HANDLER_X_Y.
OVERRIDE_HANDLER_colors_primary="apply_override_colors_primary"
OVERRIDE_HANDLER_colors_accent="apply_override_colors_accent"
OVERRIDE_HANDLER_typography_heading="apply_override_typography_heading"
OVERRIDE_HANDLER_typography_body="apply_override_typography_body"
OVERRIDE_HANDLER_typography_mono="apply_override_typography_mono"
OVERRIDE_HANDLER_voice_terms="apply_override_voice_terms"

_override_handler_var() {
  # Convert key (e.g. "colors.primary") to variable name (e.g. "OVERRIDE_HANDLER_colors_primary")
  local varname
  varname=$(echo "$1" | sed 's/\./_/g')
  echo "OVERRIDE_HANDLER_${varname}"
}

apply_override() {
  local key="$1"
  local value="$2"

  local handler_var handler
  handler_var=$(_override_handler_var "$key")
  handler="${!handler_var:-}"
  if [[ -n "$handler" ]]; then
    "$handler" "$value"
  else
    err "Unknown override key: $key (no handler registered)"
    return 1
  fi
}

# ── Override handlers ────────────────────────────────────────────────────────

apply_override_voice_terms() {
  local value="$1"
  local file="$BRAND_DIR/voice.md"

  if [[ ! -f "$file" ]]; then
    err "voice.md not found in $BRAND_DIR"
    return 1
  fi

  if ! echo "$value" | jq -e '.' >/dev/null 2>&1; then
    err "voice.terms override must be a valid JSON array"
    return 1
  fi

  local rows
  rows=$(echo "$value" | jq -r '.[] | "| \(.term) | \(.reason) | \(.use_instead) |"')
  if [[ -z "$rows" ]]; then
    log "  voice.terms: no project-specific terms to append"
    return 0
  fi

  local table_end
  table_end=$(grep -n '^## ' "$file" | grep -A1 'Forbidden Terms' | tail -1 | cut -d: -f1)
  if [[ -z "$table_end" ]]; then
    table_end=$(wc -l < "$file" | tr -d ' ')
  else
    table_end=$((table_end - 1))
  fi

  local tmpfile
  tmpfile=$(mktemp)
  head -n "$table_end" "$file" > "$tmpfile"
  echo "$rows" >> "$tmpfile"
  tail -n +$((table_end + 1)) "$file" >> "$tmpfile"
  mv "$tmpfile" "$file"

  log "  Applied voice.terms: appended project-specific forbidden terms"
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  if [[ ! -d "$BRAND_DIR" ]]; then
    echo "No brand configured. Run /petals init first."; exit 1
  fi

  log "Reading overrides from $PETALRC"
  log "Applying to $BRAND_DIR"

  local overrides
  overrides=$(parse_overrides "$PETALRC" 2>/dev/null || true)

  if [[ -z "$overrides" ]]; then
    log "No overrides found in .petalsrc"
    json_out
    exit 0
  fi

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local key="${line%%=*}"
    local val="${line#*=}"

    if [[ "$val" == "null" ]]; then
      log "Skipping $key (null — inherits from central)"
      SKIPPED_KEYS+=("$key")
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    else
      log "Applying $key=$val"
      if apply_override "$key" "$val" 2>/dev/null; then
        APPLIED_KEYS+=("$key")
        APPLIED_COUNT=$((APPLIED_COUNT + 1))
      else
        err "Failed to apply override: $key=$val"
        SKIPPED_KEYS+=("$key")
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      fi
    fi
  done <<< "$overrides"

  log "Applied $APPLIED_COUNT override(s), skipped $SKIPPED_COUNT (null-inherited)"
  json_out
}

main
