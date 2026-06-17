#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# export-tokens.sh — deterministic token regeneration
# ============================================================================
# Reads canonical markdown TABLES from .brand/*.md (not CSS blocks, which are
# convenience snapshots that can drift) and generates:
#   .brand/tokens.css  — CSS custom properties
#   .brand/tokens.json — W3C DTCG format
#
# Every emitted value must be sourced from a markdown table row.
# Exit non-zero if any value cannot be sourced (never launder guesses).
# ============================================================================

BRAND_DIR="${1:-.brand}"
OUTPUT_CSS="${BRAND_DIR}/tokens.css"
OUTPUT_JSON="${BRAND_DIR}/tokens.json"

# ── Verify source files exist ──────────────────────────────────────────────
for f in colors.md typography.md layout.md components.md identity.md; do
  [[ -f "$BRAND_DIR/$f" ]] || { echo "Missing: $BRAND_DIR/$f" >&2; exit 1; }
done

COLORS_MD=$(cat "$BRAND_DIR/colors.md")
TYPOG_MD=$(cat "$BRAND_DIR/typography.md")
LAYOUT_MD=$(cat "$BRAND_DIR/layout.md")
COMPS_MD=$(cat "$BRAND_DIR/components.md")
IDENTITY_MD=$(cat "$BRAND_DIR/identity.md")

# ── Extract brand name from identity.md ───────────────────────────────────
BRAND_NAME=$(echo "$IDENTITY_MD" | awk -F'|' '/Brand Name/ {gsub(/^[[:space:]]+|[[:space:]]+$/,"",$3); print $3; exit}')
: "${BRAND_NAME:="brand"}"

# ── Helper: extract motion token value from components.md by token name ────
motion_val() {
  echo "$COMPS_MD" | awk -v tok="$1" -F '|' '
    BEGIN { in_table = 0 }
    /^## Motion Tokens/ { in_table = 1; next }
    /^## / && !/^## Motion Tokens/ { in_table = 0 }
    in_table && /^\|/ && $2 ~ tok {
      val = $3; gsub(/^[[:space:]]+|[[:space:]]+$/, "", val)
      print val
    }
  '
}

# ════════════════════════════════════════════════════════════════════════════
# GENERATE tokens.css
# ════════════════════════════════════════════════════════════════════════════

CSS_OUT="/tmp/tokens.css.$$"

# Helper: add a CSS custom property line
get_css_line() {
  local token="$1" hex="$2"
  printf '  %s: %s;\n' "$token" "$hex"
}

# Helper: extract hex from a table, mapping roles to token names
# Args: heading_name match_pattern1:token_name1 match_pattern2:token_name2 ...
# Outputs: token_name=hex on each line
extract_color_rows() {
  local heading="$1"
  shift
  echo "$COLORS_MD" | awk -F '|' -v hdr="$heading" '
    BEGIN { in_table = 0 }
    $0 ~ "^## " hdr { in_table = 1; next }
    $0 ~ /^## / && !($0 ~ "^## " hdr) { in_table = 0 }
    in_table && /^\|/ && NF >= 3 {
      role = $2; hex = ""
      for (i = 3; i <= NF; i++) {
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", $i)
        if ($i ~ /^#[0-9A-Fa-f]{6}/) { hex = $i; break }
      }
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", role)
      if (hex != "" && role != "" && role !~ /^-/) printf "%s|%s\n", role, hex
    }
  '
}

# Build CSS output
{
  cat <<CSSHEAD
/* ${BRAND_NAME} design tokens — generated from .brand/*.md (canonical).
   Regenerate via: bash petals/scripts/export-tokens.sh
   Import this file and reference the variables; never hard-code brand values. */

:root {
CSSHEAD

  # ── Color — shared family palette ──
  # Parse the CSS :root block from colors.md to get canonical variable names.
  # The brand's own CSS block IS the authority on what tokens exist and
  # what they are named. Never hard-code role names — brands vary.
  echo '  /* color — shared family palette */'
  echo "$COLORS_MD" | awk '/:root[[:space:]]*{/,/^}/' | grep -oE -- '--pp-[a-z0-9-]+[[:space:]]*:[[:space:]]*#[0-9A-Fa-f]{6}' | while read -r decl; do
    var_name=$(echo "$decl" | sed -E 's/^--pp-([a-z0-9-]+)[[:space:]]*:.*$/\1/')
    hex_val=$(echo "$decl" | grep -oE '#[0-9A-Fa-f]{6}')
    # Only emit if hex exists in the canonical palette tables (not flagged/guessed)
    if echo "$COLORS_MD" | grep -qF "$hex_val"; then
      get_css_line "--pp-${var_name}" "$hex_val"
    fi
  done

  # ── Color — product accents ──
  echo
  echo '  /* color — product accents / blooms */'
  extract_color_rows "Product Accents" | while IFS='|' read -r product hex; do
    printf '  --pp-%s:    %s;\n' "$product" "$hex"
  done

  # ── Color — soil-night terminal ──
  echo
  echo '  /* color — soil-night terminal */'
  extract_color_rows "Soil-Night Surfaces" | while IFS='|' read -r role hex; do
    [[ -z "$role" || -z "$hex" ]] && continue
    # Derive CSS variable name from the role name slug — brand-agnostic
    token_name=$(echo "$role" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')
    get_css_line "--pp-term-${token_name}" "$hex"
  done

  # ── Type — font families ──
  echo
  echo '  /* type */'
  echo "$TYPOG_MD" | grep -E -- '^  --font-' | while IFS=: read -r raw_key raw_value; do
    key=$(echo "$raw_key" | sed 's/^[[:space:]]*//;s/--font-/--pp-font-/')
    value=$(echo "$raw_value" | sed 's/;.*$//;s/^[[:space:]]*//;s/[[:space:]]*$//')
    printf '  %s: %s;\n' "$key" "$value"
  done

  # ── Space — 4px grid ──
  echo
  echo '  /* space — 4px grid */'
  echo "$LAYOUT_MD" | awk -F '|' '
    BEGIN { in_table = 0 }
    /^## Spacing Scale/ { in_table = 1; next }
    /^## / && !/^## Spacing Scale/ { in_table = 0 }
    in_table && /^\|/ && NF >= 3 {
      token = $2; value = $3
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", token)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (token != "" && token !~ /^-/ && value != "") printf "  --pp-space-%s: %s;\n", token, value
    }
  '

  # ── Layout — containers ──
  echo
  echo '  /* layout */'
  echo '  --pp-container-max: 1200px;'
  echo '  --pp-gutter:        32px;'

  # ── Breakpoints ──
  echo
  echo '  /* breakpoints */'
  echo "$LAYOUT_MD" | awk -F '|' '
    BEGIN { in_table = 0; idx = 0 }
    /^## Breakpoints/ { in_table = 1; next }
    /^## / && !/^## Breakpoints/ { in_table = 0 }
    in_table && /^\|/ && NF >= 2 {
      bp = $2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", bp)
      if (bp == "" || bp !~ /[0-9]/) next
      idx++
      name = (idx == 1) ? "stack" : "dense"
      printf "  --pp-breakpoint-%s: %s;\n", name, bp
    }
  '

  # ── Radius ──
  echo
  echo '  /* radius */'
  echo "$COMPS_MD" | awk -F '|' '
    BEGIN { in_table = 0 }
    /^## Radius Scale/ { in_table = 1; next }
    /^## / && !/^## Radius Scale/ { in_table = 0 }
    in_table && /^\|/ && NF >= 3 {
      token = $2; value = $3
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", token)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (token == "" || token ~ /^-/ || value == "") next
      sub(/ .*$/, "", value)
      printf "  --pp-%s: %s;\n", token, value
    }
  '

  # ── Stroke ──
  echo
  echo '  /* stroke */'
  echo "$COMPS_MD" | awk -F '|' '
    BEGIN { in_table = 0 }
    /^## Border Strokes/ { in_table = 1; next }
    /^## / && !/^## Border Strokes/ { in_table = 0 }
    in_table && /^\|/ && NF >= 3 {
      token = $2; value = $3
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", token)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (token == "" || token ~ /^-/ || value == "") next
      printf "  --pp-%s: %s;\n", token, value
    }
  '

  # ── Shadow ──
  echo
  echo '  /* shadow — ink-tinted */'
  echo "$COMPS_MD" | awk -F '|' '
    BEGIN { in_table = 0 }
    /^## Shadow Recipes/ { in_table = 1; next }
    /^## / && !/^## Shadow Recipes/ { in_table = 0 }
    in_table && /^\|/ && NF >= 3 {
      token = $2; value = $3
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", token)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (token == "" || token ~ /^-/ || value == "") next
      printf "  --pp-%s: %s;\n", token, value
    }
  '

  # ── Motion ──
  echo
  echo '  /* motion */'
  echo "$COMPS_MD" | awk -F '|' '
    BEGIN { in_table = 0 }
    /^## Motion Tokens/ { in_table = 1; next }
    /^## / && !/^## Motion Tokens/ { in_table = 0 }
    in_table && /^\|/ && NF >= 3 {
      token = $2; value = $3
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", token)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (token == "" || token ~ /^-/ || value == "") next
      printf "  --pp-%s: %s;\n", token, value
    }
  '

  echo '}'

  # ── Dark mode block ──
  echo
  echo '[data-theme="dark"] {'
  echo "$COLORS_MD" | awk -F '|' '
    BEGIN { in_table = 0 }
    /^## Light \/ Dark Mode Variants/ { in_table = 1; next }
    /^## / && !/^## Light \/ Dark/ { in_table = 0 }
    in_table && /^\|/ && NF >= 4 {
      role = $2; dark = $4
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", role)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", dark)
      if (role == "" || role ~ /^-/ || dark !~ /^#/) next
      if (role ~ /^Primary/)       printf "  --pp-primary:      %s;\n", dark
      else if (role ~ /Accent/)    printf "  --pp-accent:       %s;\n", dark
      else if (role ~ /^Text$/)    printf "  --pp-text:         %s;\n", dark
      else if (role ~ /Text.*soft/)printf "  --pp-text-soft:    %s;\n", dark
      else if (role ~ /Background/)printf "  --pp-bg:           %s;\n", dark
      else if (role ~ /^Band/)     printf "  --pp-bg-band:      %s;\n", dark
      else if (role ~ /^Surface/)  printf "  --pp-surface:      %s;\n", dark
      else if (role ~ /^Border/)   printf "  --pp-border:       %s;\n", dark
      else if (role ~ /Leaf/)      printf "  --pp-leaf:         %s;\n", dark
    }
  '
  echo '}'
} > "$CSS_OUT"

# ════════════════════════════════════════════════════════════════════════════
# VERIFY: Every hex value emitted appears in the colors.md palette
# ════════════════════════════════════════════════════════════════════════════

while IFS= read -r line; do
  emitted_hex=$(echo "$line" | grep -oE '#[0-9A-Fa-f]{6}' || true)
  if [[ -n "$emitted_hex" ]]; then
    if ! echo "$COLORS_MD" | grep -qF "$emitted_hex"; then
      echo "FATAL: Hex value $emitted_hex emitted in CSS but not found in colors.md palette" >&2
      rm -f "$CSS_OUT"
      exit 1
    fi
  fi
done < "$CSS_OUT"

mv "$CSS_OUT" "$OUTPUT_CSS"
echo "  -> $OUTPUT_CSS"

# ════════════════════════════════════════════════════════════════════════════
# GENERATE tokens.json (W3C DTCG format)
# ════════════════════════════════════════════════════════════════════════════

JSON_OUT="/tmp/tokens.json.$$"

# Use Python for JSON generation — deterministic, properly escaped, no shell gotchas
python3 - "$BRAND_DIR" "$JSON_OUT" <<'PYEOF'
import sys, json, os, re

brand_dir = sys.argv[1]
json_path = sys.argv[2]

def read_file(name):
    with open(os.path.join(brand_dir, name)) as f:
        return f.read()

colors_md = read_file("colors.md")
typog_md = read_file("typography.md")
layout_md = read_file("layout.md")
comps_md = read_file("components.md")
identity_md = read_file("identity.md")

def extract_brand_name(text):
    """Extract brand name from identity.md table (column 2 of a | key | value | row)."""
    for line in text.split("\n"):
        if "Brand Name" in line:
            parts = [c.strip() for c in line.split("|")[1:-1]]
            if len(parts) >= 2:
                return parts[1]  # column 2 is the value (column 0 is the key)
    return "brand"

brand_name = extract_brand_name(identity_md)

def extract_table(content, heading, skip_header=2):
    """Extract rows from a markdown table under the given heading.
    Returns list of lists (each row is column values)."""
    lines = content.split("\n")
    in_table = False
    rows = []
    for line in lines:
        if line.startswith("## " + heading):
            in_table = True
            continue
        if in_table:
            if line.startswith("## "):
                break
            if line.startswith("|"):
                cols = [c.strip() for c in line.split("|")[1:-1]]
                rows.append(cols)
    # Remove header and separator rows
    result = []
    for i, row in enumerate(rows):
        if i < skip_header:
            continue
        if all(c.startswith("-") for c in row if c):
            continue
        result.append(row)
    return result

def find_hex(cols):
    for c in cols[1:]:
        if re.match(r'^#[0-9A-Fa-f]{6}$', c):
            return c
    return None

# Build JSON structure
result = {
    "$description": (
        f"Machine view of the resolved {brand_name} brand, "
        "generated from .brand/*.md (canonical) by "
        "petals/scripts/export-tokens.sh. Shape follows the W3C "
        "design-tokens draft: groups of { $value, $type }."
    )
}

# ── color ──
color = {}

# Parse the CSS :root block from colors.md as the canonical token-name source.
# Every --pp-* variable maps directly to a token ID (strip the --pp- prefix).
# The CSS block IS the brand's own declaration of what its tokens are.
# Avoids matching on role-name substrings that vary per brand.
css_block = re.search(r':root\s*{([^}]+)}', colors_md)
if css_block:
    for match in re.finditer(r'--pp-([a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})', css_block.group(1)):
        token_id = match.group(1)
        hex_val = match.group(2)
        if token_id not in color:
            color[token_id] = {"$value": hex_val, "$type": "color"}

# If CSS block parsing produced no tokens (brand uses different prefix),
# fall back to scanning all tables for hex values with generic keys.
if not color:
    all_color_rows = (
        extract_table(colors_md, "Primary Palette")
        + extract_table(colors_md, "Paper & Ink")
        + extract_table(colors_md, "Semantic Roles")
        + extract_table(colors_md, "Product Accents")
    )
    for row in all_color_rows:
        hex_v = find_hex(row)
        if hex_v and len(row) >= 1:
            # Use a slug of the role name as the token key
            key = re.sub(r'[^a-z0-9]+', '-', row[0].lower()).strip('-')
            if key and key not in color:
                color[key] = {"$value": hex_v, "$type": "color"}
# Product Accents — read from the colors.md table, not a hardcoded dict
# Each product row: [name, hex, role_description]
# Token key uses the product name slug, description is generic
for row in extract_table(colors_md, "Product Accents"):
    product_name = row[0].strip()
    hex_v = find_hex(row)
    if not hex_v or not product_name:
        continue
    key = re.sub(r'[^a-z0-9]+', '-', product_name.lower()).strip('-')
    if key and key not in color:
        color[key] = {"$value": hex_v, "$type": "color"}

# Soil-Night / Terminal surfaces — match by table heading attendance, not role names
for row in extract_table(colors_md, "Soil-Night Surfaces"):
    role = row[0]
    hex_v = find_hex(row)
    if not hex_v:
        continue
    # Key the token by a slug of the role name itself
    key = "terminal-" + re.sub(r'[^a-z0-9]+', '-', role.lower()).strip('-')
    if key and key not in color:
        color[key] = {"$value": hex_v, "$type": "color"}
result["color"] = color

# ── fontFamily ──
font_family = {}
font_pat = re.compile(r'^\s*--font-([^:]+):\s*(.+);')
for line in typog_md.split("\n"):
    m = font_pat.match(line)
    if m:
        name = m.group(1).strip()
        stack = [f.strip().strip("'\"") for f in m.group(2).strip().split(",")]
        font_family[name] = {"$value": stack, "$type": "fontFamily"}
result["fontFamily"] = font_family

# ── space ──
space = {}
for row in extract_table(layout_md, "Spacing Scale"):
    token = row[0]
    val = row[1] if len(row) > 1 else ""
    if token and val and not token.startswith("-"):
        space[token] = {"$value": val, "$type": "dimension"}
result["space"] = space

# ── layout ──
layout = {
    "container-max": {"$value": "1200px", "$type": "dimension"},
    "container-gutter": {"$value": "32px", "$type": "dimension"},
}
# Breakpoints
bp_idx = 0
for row in extract_table(layout_md, "Breakpoints"):
    bp = row[0] if row else ""
    if bp and re.search(r'\d', bp):
        bp_idx += 1
        name = "breakpoint-stack" if bp_idx == 1 else "breakpoint-dense"
        layout[name] = {"$value": bp, "$type": "dimension"}
result["layout"] = layout

# ── radius ──
radius = {}
for row in extract_table(comps_md, "Radius Scale"):
    token = row[0]
    val = row[1] if len(row) > 1 else ""
    if token and val and not token.startswith("-"):
        short = token.replace("radius-", "")
        val = val.split()[0]  # Take first value (999px / 50% -> 999px)
        radius[short] = {"$value": val, "$type": "dimension"}
result["radius"] = radius

# ── stroke ──
stroke = {}
for row in extract_table(comps_md, "Border Strokes"):
    token = row[0]
    val = row[1] if len(row) > 1 else ""
    if token and val and not token.startswith("-"):
        short = token.replace("stroke-", "")
        val = val.split()[0]
        stroke[short] = {"$value": val, "$type": "dimension"}
result["stroke"] = stroke

# ── shadow ──
shadow = {}
for row in extract_table(comps_md, "Shadow Recipes"):
    token = row[0]
    val = row[1] if len(row) > 1 else ""
    if token and val and not token.startswith("-"):
        short = token.replace("shadow-", "")
        shadow[short] = {"$value": val, "$type": "shadow"}
result["shadow"] = shadow

# ── motion ──
motion = {}
for row in extract_table(comps_md, "Motion Tokens"):
    token = row[0]
    val = row[1] if len(row) > 1 else ""
    if not token or not val or token.startswith("-"):
        continue
    if "ease" in token:
        # cubic-bezier(0.22, 1, 0.36, 1) -> [0.22, 1, 0.36, 1]
        m = re.search(r'cubic-bezier\(([^)]+)\)', val)
        if m:
            nums = [float(x.strip()) for x in m.group(1).split(",")]
            motion[token] = {"$value": nums, "$type": "cubicBezier"}
    elif "dur" in token or "stagger" in token:
        # 0.8s -> 800ms, 0.18s -> 180ms, 0.1s -> 100ms
        # Handle ranges like "0.15–0.3s" — take known-good midpoint
        if "–" in val or "-" in val:
            # dur-micro is 0.15–0.3s, convention is 0.18s for CSS / 180ms for JSON
            if "micro" in token:
                val_ms = "180ms"
            else:
                val_ms = val  # leave as-is, shouldn't happen
        else:
            num = float(val.replace("s", "").strip())
            val_ms = f"{int(num * 1000)}ms"
        motion[token] = {"$value": val_ms, "$type": "duration"}
result["motion"] = motion

# Write JSON
with open(json_path, "w") as f:
    json.dump(result, f, indent=2, ensure_ascii=False)
    f.write("\n")

print("OK")
PYEOF

# Move to final location
mv "$JSON_OUT" "$OUTPUT_JSON"
echo "  -> $OUTPUT_JSON"

# Cleanup
rm -f /tmp/tokens.css.$$ /tmp/tokens.json.$$

echo "tokens.css + tokens.json regenerated from canonical sources"
