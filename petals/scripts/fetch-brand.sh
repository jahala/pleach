#!/bin/bash
# fetch-brand.sh — Fetch .brand/ from a central brand repository.
#
# Auto-selects the best fetch strategy from (in priority order):
#   1. Local directory path   (when source is a local path)
#   2. git clone --depth 1    (when git is available)
#   3. GitHub API             (when GITHUB_TOKEN is set)
#   4. raw.githubusercontent.com (public repo fallback)
#
# Usage:
#   fetch-brand.sh <source-url> [--ref <tag-or-branch>] [--target <dir>]
#
#   source-url  : file:///path, /absolute/path, git@..., https://github.com/...
#   --ref        : tag (v1.2.0) or branch (main). Default: latest tag or HEAD.
#   --target     : output directory. Default: ./.brand
#
# Exit codes:
#   0 — success
#   1 — no .brand/ found in source
#   2 — source unreachable (DNS, 404, network error)
#   3 — auth required but not available (private repo, no GITHUB_TOKEN/SSH)
#   4 — git/curl not available and no local path
#
# Output:
#   stdout: JSON with strategy, version, and file count
#   stderr: operational logs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
  source "$SCRIPT_DIR/lib/common.sh"
  ROOT=$(find_project_root) && cd "$ROOT"
fi
# ── Argument parsing ─────────────────────────────────────────────────────────

SOURCE_URL=""
REF=""
TARGET=".brand"
STRATEGY=""
VERSION=""
STRATEGY_LOG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)
      REF="$2"; shift 2 ;;
    --target)
      TARGET="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: fetch-brand.sh <source-url> [--ref <tag-or-branch>] [--target <dir>]"
      exit 0 ;;
    -*)
      echo "Unknown flag: $1" >&2; exit 1 ;;
    *)
      SOURCE_URL="$1"; shift ;;
  esac
done

if [[ -z "$SOURCE_URL" ]]; then
  echo "Error: source-url is required." >&2
  echo "Usage: fetch-brand.sh <source-url> [--ref <tag-or-branch>] [--target <dir>]" >&2
  exit 1
fi

# ── Helper functions ─────────────────────────────────────────────────────────

log()     { echo "[fetch-brand] $*" >&2; }
err()     { echo "[fetch-brand] ERROR: $*" >&2; }
json_out(){ echo "{\"strategy\":\"$1\",\"version\":\"$2\",\"files\":$3}"; }

# Detect version from fetched .brand/identity.md
detect_version() {
  local dir="$1"
  local identity_file="$dir/identity.md"
  if [[ -f "$identity_file" ]]; then
    local v
    # Match table row like: | Brand Version | v1.1.0 |
    v=$(grep -iE 'Brand Version' "$identity_file" 2>/dev/null | head -1 | \
        sed -E 's/^[^|]*\|[^|]*\|[[:space:]]*(v?[0-9]+\.[0-9]+\.[0-9]+)[[:space:]]*\|.*$/\1/' | \
        sed -E 's/^[^|]*\|[^|]*\|[[:space:]]*(v?[0-9]+\.[0-9]+\.[0-9]+)[[:space:]]*$/\1/')
    if [[ -z "$v" || "$v" == *"Brand Version"* ]]; then
      # Try alternate pattern: any semver-like string in the line
      v=$(grep -iE 'Brand Version' "$identity_file" 2>/dev/null | head -1 | \
          grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    fi
    if [[ -n "$v" ]] && [[ "$v" != *"Brand Version"* ]]; then
      echo "$v"
      return 0
    fi
  fi
  # Fallback: use the REF if it looks like a version tag
  if [[ -n "$REF" ]] && echo "$REF" | grep -qE '^v?[0-9]+\.[0-9]+\.[0-9]+'; then
    echo "$REF"
    return 0
  fi
  echo "unknown"
}

# Count files in .brand/ directory (recursive, excluding dirs)
count_files() {
  local dir="$1"
  find "$dir" -type f 2>/dev/null | wc -l | tr -d ' '
}

# Verify .brand/ exists with files
verify_brand_dir() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    err "No .brand/ directory found at: $dir"
    exit 1
  fi
  local count
  count=$(count_files "$dir")
  if [[ "$count" -eq 0 ]]; then
    err ".brand/ directory exists but contains no files at: $dir"
    exit 1
  fi
  log "Found .brand/ with $count files"
}

# ── Strategy detection ───────────────────────────────────────────────────────

detect_strategy() {
  local url="$1"

  # Strategy 0: Local directory path (file://, absolute, or relative)
  if [[ "$url" =~ ^file:// ]] || [[ "$url" =~ ^/ ]] || [[ "$url" =~ ^\./ ]] || [[ "$url" =~ ^\.\./ ]]; then
    # Strip file:// prefix if present
    local local_path="${url#file://}"
    STRATEGY="local"
    STRATEGY_LOG="local directory copy ($local_path)"
    return 0
  fi

  # Strategy 1: git with SSH (git available + SSH key detectable, or git@ URL)
  if command -v git &>/dev/null; then
    # Check for SSH key or git@ URL
    if [[ "$url" =~ ^git@ ]] || ssh -T git@github.com 2>&1 | grep -q "successfully authenticated"; then
      STRATEGY="git-ssh"
      STRATEGY_LOG="git clone --depth 1 (SSH)"
      return 0
    fi
    # git is available even without SSH — we can try clone (will use HTTPS if URL is https://)
    if [[ "$url" =~ ^https?:// ]] || [[ "$url" =~ ^git@ ]]; then
      STRATEGY="git"
      STRATEGY_LOG="git clone --depth 1"
      return 0
    fi
  fi

  # Strategy 2: GitHub API (GITHUB_TOKEN available)
  if [[ -n "${GITHUB_TOKEN:-}" ]] || [[ -n "${GH_TOKEN:-}" ]]; then
    if [[ "$url" =~ github\.com ]]; then
      STRATEGY="github-api"
      STRATEGY_LOG="GitHub API (GITHUB_TOKEN)"
      return 0
    fi
  fi

  # Strategy 3: raw.githubusercontent.com (public repos)
  if [[ "$url" =~ github\.com ]]; then
    STRATEGY="raw-http"
    STRATEGY_LOG="raw.githubusercontent.com"
    return 0
  fi

  # No strategy available
  err "Cannot determine fetch strategy for: $url"
  err "Available strategies require: git, GITHUB_TOKEN, or a public github.com URL"
  exit 4
}

# ── Strategy implementations ─────────────────────────────────────────────────

# Strategy 0: Local directory copy
fetch_local() {
  local src="$1"
  local target="$2"
  src="${src#file://}"

  if [[ ! -d "$src" ]]; then
    err "Local path does not exist: $src"
    exit 2
  fi

  local src_brand="$src/.brand"
  if [[ ! -d "$src_brand" ]]; then
    err "No .brand/ directory found in: $src"
    err "The source must contain a .brand/ directory at its root."
    exit 1
  fi

  log "Copying from $src_brand to $target"
  mkdir -p "$target"
  cp -r "$src_brand"/* "$target/" 2>/dev/null || {
    err "Failed to copy .brand/ contents from $src"
    exit 1
  }

  VERSION=$(detect_version "$target")
  local count
  count=$(count_files "$target")
  log "Local copy complete: $count files, version=$VERSION"
}

# Strategy 1/1b: git clone
fetch_git() {
  local url="$1"
  local target="$2"
  local tmpdir
  tmpdir=$(mktemp -d /tmp/brand-fetch-XXXXXX)
  trap "trash \"$tmpdir\" 2>/dev/null || true" EXIT

  local clone_args=("clone" "--depth" "1")
  local ref="$REF"

  # If no ref specified, try to get the latest tag
  if [[ -z "$ref" ]]; then
    log "No --ref specified; cloning default branch HEAD"
  else
    clone_args+=("--branch" "$ref")
  fi

  log "Running: git ${clone_args[*]} $url $tmpdir"
  if ! git "${clone_args[@]}" "$url" "$tmpdir" 2>/dev/null; then
    err "git clone failed for: $url"
    err "Check that the repo exists and you have access."
    exit 2
  fi

  local src_brand="$tmpdir/.brand"
  if [[ ! -d "$src_brand" ]]; then
    err "Repository cloned but no .brand/ directory found at: $url"
    trash "$tmpdir" 2>/dev/null || true
    exit 1
  fi

  # Get the latest tag for version detection if no ref specified
  if [[ -z "$ref" ]]; then
    ref=$(cd "$tmpdir" && git describe --tags --abbrev=0 2>/dev/null || echo "")
    if [[ -n "$ref" ]]; then
      log "Detected latest tag: $ref"
    fi
  fi

  log "Copying .brand/ from cloned repo to $target"
  mkdir -p "$target"
  cp -r "$src_brand"/* "$target/" 2>/dev/null || {
    err "Failed to copy .brand/ contents from cloned repo"
    exit 1
  }

  VERSION=$(detect_version "$target")
  local count
  count=$(count_files "$target")
  log "git clone complete: $count files, version=$VERSION"

  trash "$tmpdir" 2>/dev/null || true
  trap - EXIT
}

# Strategy 2: GitHub API
# Extracts owner/repo from github.com URL
parse_github_url() {
  local url="$1"
  # github.com/owner/repo or github.com/owner/repo.git or git@github.com:owner/repo.git
  local owner_repo
  owner_repo=$(echo "$url" | sed -E 's|^https?://github\.com/||; s|\.git$||; s|^git@github\.com:||; s|/$||')
  echo "$owner_repo"
}

fetch_github_api() {
  local url="$1"
  local target="$2"
  local token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

  local owner_repo
  owner_repo=$(parse_github_url "$url")
  local ref="${REF:-main}"

  log "Fetching .brand/ via GitHub API from $owner_repo (ref=$ref)"

  # Get the tree for .brand/ path
  local api_url="https://api.github.com/repos/${owner_repo}/contents/.brand"
  if [[ -n "$ref" ]]; then
    api_url="${api_url}?ref=${ref}"
  fi

  local listing
  listing=$(curl -s -H "Authorization: Bearer $token" \
                  -H "Accept: application/vnd.github+json" \
                  -H "X-GitHub-Api-Version: 2022-11-28" \
                  "$api_url" 2>/dev/null) || {
    err "Failed to reach GitHub API for: $owner_repo"
    exit 2
  }

  # Check for errors
  if echo "$listing" | grep -q '"message"' 2>/dev/null; then
    local msg
    msg=$(echo "$listing" | grep '"message"' | head -1 | sed -E 's/.*"message"\s*:\s*"([^"]+)".*/\1/')
    if echo "$msg" | grep -qi "not found"; then
      err "No .brand/ directory found in $owner_repo (ref=$ref)"
      exit 1
    elif echo "$msg" | grep -qi "bad credentials\|requires authentication\|not authorized"; then
      err "Authentication required for $owner_repo. Set GITHUB_TOKEN."
      exit 3
    else
      err "GitHub API error: $msg"
      exit 2
    fi
  fi

  # Parse file listing and download each file recursively
  mkdir -p "$target"
  download_github_contents "$listing" "$target" "$token"

  VERSION=$(detect_version "$target")
  local count
  count=$(count_files "$target")
  log "GitHub API fetch complete: $count files, version=$VERSION"
}

# Recursively download files and directories from GitHub API
download_github_contents() {
  local listing="$1"
  local target="$2"
  local token="$3"

  # Parse the JSON array for files and subdirectories
  echo "$listing" | jq -c '.[]?' 2>/dev/null | while IFS= read -r item; do
    local type name download_url git_url
    type=$(echo "$item" | jq -r '.type // empty')
    name=$(echo "$item" | jq -r '.name // empty')
    download_url=$(echo "$item" | jq -r '.download_url // empty')
    git_url=$(echo "$item" | jq -r '.git_url // empty')

    if [[ -z "$name" ]]; then continue; fi

    if [[ "$type" == "dir" ]]; then
      # Recurse into directory
      local sub_listing
      sub_listing=$(curl -s -H "Authorization: Bearer $token" \
                          -H "Accept: application/vnd.github+json" \
                          -H "X-GitHub-Api-Version: 2022-11-28" \
                          "$git_url" 2>/dev/null)
      download_github_contents "$sub_listing" "$target/$name" "$token"
    elif [[ "$type" == "file" && -n "$download_url" ]]; then
      log "  Downloading: .brand/$name"
      curl -s -L -H "Authorization: Bearer $token" \
           -H "Accept: application/vnd.github+json" \
           -H "X-GitHub-Api-Version: 2022-11-28" \
           "$download_url" -o "$target/$name" 2>/dev/null || {
        err "Failed to download: $name"
      }
    fi
  done
}

# Strategy 3: raw.githubusercontent.com
fetch_raw_http() {
  local url="$1"
  local target="$2"

  local owner_repo
  owner_repo=$(parse_github_url "$url")
  local ref="${REF:-main}"

  log "Fetching .brand/ via raw.githubusercontent.com from $owner_repo (ref=$ref)"

  local raw_base="https://raw.githubusercontent.com/${owner_repo}/${ref}/.brand"

  # Known brand files to fetch
  local known_files=(
    "DESIGN.md"
    "colors.md"
    "typography.md"
    "voice.md"
    "identity.md"
    "assets/logo.svg"
    "assets/hero.jpg"
  )

  # First, try listing via GitHub API to get file list (no auth needed for public repos)
  local api_url="https://api.github.com/repos/${owner_repo}/contents/.brand?ref=${ref}"
  local listing
  listing=$(curl -s -H "Accept: application/vnd.github+json" \
                  -H "X-GitHub-Api-Version: 2022-11-28" \
                  "$api_url" 2>/dev/null) || true

  mkdir -p "$target"

  if echo "$listing" | jq -e 'type == "array"' >/dev/null 2>&1; then
    # Parse the file listing and download each file via raw URLs
    echo "$listing" | jq -c '.[]?' 2>/dev/null | while IFS= read -r item; do
      local type name download_url git_url
      type=$(echo "$item" | jq -r '.type // empty')
      name=$(echo "$item" | jq -r '.name // empty')
      download_url=$(echo "$item" | jq -r '.download_url // empty')
      git_url=$(echo "$item" | jq -r '.git_url // empty')

      if [[ -z "$name" ]]; then continue; fi

      if [[ "$type" == "dir" ]]; then
        local raw_sub="https://raw.githubusercontent.com/${owner_repo}/${ref}/.brand/$name"
        local sub_listing
        sub_listing=$(curl -s -H "Accept: application/vnd.github+json" \
                            -H "X-GitHub-Api-Version: 2022-11-28" \
                            "https://api.github.com/repos/${owner_repo}/contents/.brand/${name}?ref=${ref}" 2>/dev/null)
        if echo "$sub_listing" | jq -e 'type == "array"' >/dev/null 2>&1; then
          echo "$sub_listing" | jq -c '.[]?' 2>/dev/null | while IFS= read -r subitem; do
            local sname sdl
            sname=$(echo "$subitem" | jq -r '.name // empty')
            sdl=$(echo "$subitem" | jq -r '.download_url // empty')
            if [[ -n "$sname" && -n "$sdl" && "$sdl" != "null" ]]; then
              mkdir -p "$target/$name"
              log "  Downloading: .brand/$name/$sname"
              curl -s -L "$sdl" -o "$target/$name/$sname" 2>/dev/null || {
                err "Failed to download: $name/$sname"
              }
            fi
          done
        fi
      elif [[ "$type" == "file" && -n "$download_url" && "$download_url" != "null" ]]; then
        log "  Downloading: .brand/$name"
        curl -s -L "$download_url" -o "$target/$name" 2>/dev/null || {
          err "Failed to download: $name"
        }
      fi
    done
  else
    # Fallback: try known files
    log "Could not list directory; trying known files..."
    local any_success=false
    for f in "${known_files[@]}"; do
      local file_url="${raw_base}/${f}"
      local file_target="$target/$f"
      local dir_target
      dir_target=$(dirname "$file_target")
      mkdir -p "$dir_target"
      local http_code
      http_code=$(curl -s -o "$file_target" -w '%{http_code}' -L "$file_url" 2>/dev/null)
      if [[ "$http_code" == "200" ]]; then
        log "  Downloaded: $f"
        any_success=true
      else
        trash "$file_target" 2>/dev/null || true
      fi
    done
    if ! $any_success; then
      err "No .brand/ files found via raw.githubusercontent.com for $owner_repo"
      err "Check that the repo is public and has a .brand/ directory."
      exit 1
    fi
  fi

  VERSION=$(detect_version "$target")
  local count
  count=$(count_files "$target")
  log "Raw HTTP fetch complete: $count files, version=$VERSION"
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  detect_strategy "$SOURCE_URL"
  log "Strategy: $STRATEGY_LOG"

  case "$STRATEGY" in
    local)
      fetch_local "$SOURCE_URL" "$TARGET"
      ;;
    git|git-ssh)
      fetch_git "$SOURCE_URL" "$TARGET"
      ;;
    github-api)
      fetch_github_api "$SOURCE_URL" "$TARGET"
      ;;
    raw-http)
      fetch_raw_http "$SOURCE_URL" "$TARGET"
      ;;
    *)
      err "Unknown strategy: $STRATEGY"
      exit 4
      ;;
  esac

  verify_brand_dir "$TARGET"
  local count
  count=$(count_files "$TARGET")
  json_out "$STRATEGY" "$VERSION" "$count"
}

main
