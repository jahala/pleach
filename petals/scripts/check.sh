#!/usr/bin/env bash
# petals/scripts/check.sh — the deterministic core of /petals check.
#
# Covers the pure-math dimensions without an agent in the loop:
#   color    — hex literals vs the palette (data-URI/base64/url() excluded),
#              nearest palette match by RGB distance; contrast ratios for
#              same-rule color/background pairs (one-level var() resolution):
#              < 3.0 error, 3.0–4.5 warning (verify the pair class), >= 4.5 pass
#   layout   — padding/margin/gap px vs the spacing scale (multiples rule),
#              @media widths vs the documented breakpoints
#   surface  — border-radius vs the radius scale, overshoot cubic-beziers,
#              un-tinted (pure black) shadows
#   voice    — forbidden terms (with replacements), unambiguous banned
#              terminology phrases, capitalized product names
#
# Stays with the agent (run via the skill): typography role classification,
# tone, and dismissing quoted-context voice hits the heuristic misses.
# Quote-context heuristic: lines containing never / use instead / forbidden /
# class="no" are skipped by the voice pass (they quote the rule, not break it).
#
# Usage: check.sh <file> [--brand <dir>]   (default brand dir: .brand)
# Exit: 0 when zero errors, 1 when any error present (binary pass/fail).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
  source "$SCRIPT_DIR/lib/common.sh"
  ROOT=$(find_project_root) && cd "$ROOT"
fi
TARGET="${1:?usage: check.sh <file> [--brand <dir>] [--product <name>]}"
shift || true
BRAND=".brand"; PRODUCT=""; JSON_MODE=0; FIX_MODE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --brand)   BRAND="${2:?--brand needs a dir}"; shift 2 ;;
    --json)    JSON_MODE=1; shift ;;
    --product) PRODUCT="${2:?--product needs a name}"; shift 2 ;;
    --fix)     FIX_MODE=1; shift ;;
    *) shift ;;
  esac
done
# product context: flag > .petalsrc > the single products/ dir > flat brand
if [ -z "$PRODUCT" ] && [ -f .petalsrc ]; then
  PRODUCT=$(awk -F': *' '/^[ ]*product:/{print $2; exit}' .petalsrc 2>/dev/null)
fi
[ -f "$TARGET" ] || { echo "ERROR target file not found: $TARGET"; exit 1; }
[ -d "$BRAND" ] || { echo "No brand configured. Run /petals init first."; exit 1; }

if [ -z "$PRODUCT" ] && [ -d "$BRAND/products" ]; then
  PCOUNT=$(ls -1 "$BRAND/products" 2>/dev/null | wc -l | tr -d " ")
  [ "$PCOUNT" = "1" ] && PRODUCT=$(ls -1 "$BRAND/products")
fi
[ -n "$PRODUCT" ] && [ -f "$BRAND/products/$PRODUCT/voice.md" ] && PRODUCT_VOICE="$BRAND/products/$PRODUCT/voice.md"

# ── tokens drift detection ──
TOKENS_CSS="$BRAND/tokens.css"
if [ -f "$TOKENS_CSS" ]; then
  # Compare high-signal token values against canonical sources.
  # colors.md canonical: CSS :root block values.
  # typography.md canonical: Font Families table values.

  # Primary color
  CANON_PRIMARY=$(awk -F'[ ;]' '/--pp-primary:/{gsub(/^[ ]*--pp-primary:[ ]*/,""); gsub(/[ ;].*/,""); print; exit}' "$BRAND/colors.md" 2>/dev/null | tr -d '\n')
  TOKENS_PRIMARY=$(awk -F'[ ;]' '/--pp-primary:/{gsub(/^[ ]*--pp-primary:[ ]*/,""); gsub(/[ ;].*/,""); print; exit}' "$TOKENS_CSS" 2>/dev/null | tr -d '\n')
  if [ -n "$CANON_PRIMARY" ] && [ -n "$TOKENS_PRIMARY" ] && [ "$CANON_PRIMARY" != "$TOKENS_PRIMARY" ]; then
    echo "WARNING [tokens] tokens.css --pp-primary: $TOKENS_PRIMARY does not match colors.md: $CANON_PRIMARY" >&2
  fi

  # Accent color
  CANON_ACCENT=$(awk -F'[ ;]' '/--pp-accent:/{gsub(/^[ ]*--pp-accent:[ ]*/,""); gsub(/[ ;].*/,""); print; exit}' "$BRAND/colors.md" 2>/dev/null | tr -d '\n')
  TOKENS_ACCENT=$(awk -F'[ ;]' '/--pp-accent:/{gsub(/^[ ]*--pp-accent:[ ]*/,""); gsub(/[ ;].*/,""); print; exit}' "$TOKENS_CSS" 2>/dev/null | tr -d '\n')
  if [ -n "$CANON_ACCENT" ] && [ -n "$TOKENS_ACCENT" ] && [ "$CANON_ACCENT" != "$TOKENS_ACCENT" ]; then
    echo "WARNING [tokens] tokens.css --pp-accent: $TOKENS_ACCENT does not match colors.md: $CANON_ACCENT" >&2
  fi

  # Text color
  CANON_TEXT=$(awk -F'[ ;]' '/--pp-text:/{gsub(/^[ ]*--pp-text:[ ]*/,""); gsub(/[ ;].*/,""); print; exit}' "$BRAND/colors.md" 2>/dev/null | tr -d '\n')
  TOKENS_TEXT=$(awk -F'[ ;]' '/--pp-text:/{gsub(/^[ ]*--pp-text:[ ]*/,""); gsub(/[ ;].*/,""); print; exit}' "$TOKENS_CSS" 2>/dev/null | tr -d '\n')
  if [ -n "$CANON_TEXT" ] && [ -n "$TOKENS_TEXT" ] && [ "$CANON_TEXT" != "$TOKENS_TEXT" ]; then
    echo "WARNING [tokens] tokens.css --pp-text: $TOKENS_TEXT does not match colors.md: $CANON_TEXT" >&2
  fi

  # Background color
  CANON_BG=$(awk -F'[ ;]' '/--pp-bg:/{gsub(/^[ ]*--pp-bg:[ ]*/,""); gsub(/[ ;].*/,""); print; exit}' "$BRAND/colors.md" 2>/dev/null | tr -d '\n')
  TOKENS_BG=$(awk -F'[ ;]' '/--pp-bg:/{gsub(/^[ ]*--pp-bg:[ ]*/,""); gsub(/[ ;].*/,""); print; exit}' "$TOKENS_CSS" 2>/dev/null | tr -d '\n')
  if [ -n "$CANON_BG" ] && [ -n "$TOKENS_BG" ] && [ "$CANON_BG" != "$TOKENS_BG" ]; then
    echo "WARNING [tokens] tokens.css --pp-bg: $TOKENS_BG does not match colors.md: $CANON_BG" >&2
  fi

  # Heading font
  CANON_HEADING=$(awk -F'|' '/^## Font Families/{f=1} /^## /{if(f&&!~/Font Families/)f=0} f && NF>=3 && $2!~/Role|---/{gsub(/^ +| +$/,"",$3); if($2~/Heading/){if($3!=""){print $3; exit}}}' "$BRAND/typography.md" 2>/dev/null | tr -d '\n')
  TOKENS_HEADING=$(awk -F'[ ;]' '/--pp-font-heading:/{gsub(/^[ ]*--pp-font-heading:[ ]*/,""); gsub(/[ ;].*/,""); gsub(/^'"'"'|'"'"'$/,""); print; exit}' "$TOKENS_CSS" 2>/dev/null | tr -d '\n')
  if [ -n "$CANON_HEADING" ] && [ -n "$TOKENS_HEADING" ] && [ "$CANON_HEADING" != "$TOKENS_HEADING" ]; then
    echo "WARNING [tokens] tokens.css --pp-font-heading: $TOKENS_HEADING does not match typography.md: $CANON_HEADING" >&2
  fi

  # Body font
  CANON_BODY=$(awk -F'|' '/^## Font Families/{f=1} /^## /{if(f&&!~/Font Families/)f=0} f && NF>=3 && $2!~/Role|---/{gsub(/^ +| +$/,"",$3); if($2~/Body/){if($3!=""){print $3; exit}}}' "$BRAND/typography.md" 2>/dev/null | tr -d '\n')
  TOKENS_BODY=$(awk -F'[ ;]' '/--pp-font-body:/{gsub(/^[ ]*--pp-font-body:[ ]*/,""); gsub(/[ ;].*/,""); gsub(/^'"'"'|'"'"'$/,""); print; exit}' "$TOKENS_CSS" 2>/dev/null | tr -d '\n')
  if [ -n "$CANON_BODY" ] && [ -n "$TOKENS_BODY" ] && [ "$CANON_BODY" != "$TOKENS_BODY" ]; then
    echo "WARNING [tokens] tokens.css --pp-font-body: $TOKENS_BODY does not match typography.md: $CANON_BODY" >&2
  fi
fi

# Product accents from the umbrella Product Accents table ("HEX|name" rows).
# In a product context, other products accents are markers, not UI colors.
ACCENTS=$(awk -F"|" "/^## Product Accents/{f=1} /^## /{if(f&&\$0!~/Product Accents/)f=0} f && NF>=4 && \$3~/#[0-9a-fA-F]{6}/ {gsub(/^ +| +\$/,\"\",\$2); gsub(/^ +| +\$/,\"\",\$3); print toupper(\$3) \"|\" \$2}" "$BRAND/colors.md" 2>/dev/null | tr "\n" "\036")
PRODUCT_NAMES=$(awk -F"|" "/^## Product Accents/{f=1} /^## /{if(f&&\$0!~/Product Accents/)f=0} f && NF>=4 && \$3~/#[0-9a-fA-F]{6}/ {gsub(/^ +| +\$/,\"\",\$2); print tolower(\$2)}" "$BRAND/colors.md" 2>/dev/null | tr "\n" "\034")

PALETTE=$(grep -ohE '#[0-9a-fA-F]{6}' "$BRAND/colors.md" 2>/dev/null | tr 'a-f' 'A-F' | sort -u | tr '\n' ' ')
RADII=$(grep -ohE '^\| radius-[a-z]+ \| [0-9]+px' "$BRAND/components.md" 2>/dev/null | grep -oE '[0-9]+px' | tr '\n' ' ')
BREAKPOINTS=$(grep -ohE '^\| [0-9]+px' "$BRAND/layout.md" 2>/dev/null | grep -oE '[0-9]+' | tr '\n' ' ')
SPACE_UNIT=4

# Documented contrast pairs from colors.md's Contrast Pairings table:
# "HEX1|HEX2|class" rows, \036-joined. A documented class overrides the
# generic thresholds (the table is the brand's own classification).
DOCPAIRS=$(awk '/^## Contrast Pairings/{f=1;next} /^## /{f=0} f && /^\|.* on .*\|/ {
  n=0; delete hx
  line=$0
  while(match(line, /#[0-9a-fA-F]{6}/)){ hx[++n]=toupper(substr(line,RSTART,RLENGTH)); line=substr(line,RSTART+RLENGTH) }
  if(n>=2){
    nf=split($0, cols, "|")
    cls=cols[nf-1]; gsub(/^ +| +$/, "", cls)
    print hx[1] "|" hx[2] "|" cls
  }
}' "$BRAND/colors.md" 2>/dev/null | tr '\n' '\036')

# Forbidden terms: "term<TAB>alternatives" rows from voice.md's Forbidden Terms
# table, newline -> \036 (awk -v cannot carry newlines portably)
FORBIDDEN=$(awk -F'|' '/^## Forbidden Terms/{f=1} /^## /{if(f&&$0!~/Forbidden/)f=0} f && NF>=4 && $2!~/Term|---/ {gsub(/^ +| +$/,"",$2); gsub(/^ +| +$/,"",$4); if($2!="") print $2"\t"$4}' "$BRAND/voice.md" $PRODUCT_VOICE 2>/dev/null | tr '\n' '\036')
# Terminology: "canonical<TAB>banned_synonym" from voice.md Terminology table
TERMS=$(awk -F'|' '/^## Terminology/{f=1} /^## /{if(f&&$0!~/Terminology/)f=0} f && NF>=4 && $2!~/Use|---/ {gsub(/^ +| +$/,"",$2); gsub(/^ +| +$/,"",$3); if($3!=""){ n=split($3, syns, ","); for(i=1;i<=n;i++){ gsub(/^ +| +$/,"",syns[i]); gsub(/"/,"",syns[i]); if(syns[i]!="") print $2"\t"syns[i] }}}' "$BRAND/voice.md" $PRODUCT_VOICE 2>/dev/null | tr '\n' '\036')

awk -v palette="$PALETTE" -v radii="$RADII" -v bps="$BREAKPOINTS" \
    -v unit="$SPACE_UNIT" -v forbidden="$FORBIDDEN" -v docpairs="$DOCPAIRS" -v accents="$ACCENTS" -v product="$PRODUCT" -v terms="$TERMS" -v pnames="$PRODUCT_NAMES" -v json="$JSON_MODE" '
function hexval(c,   i){ return index("0123456789ABCDEF", toupper(c)) - 1 }
function h2(s){ return hexval(substr(s,1,1))*16 + hexval(substr(s,2,1)) }
function expand(h){ if(length(h)==4) return "#" substr(h,2,1) substr(h,2,1) substr(h,3,1) substr(h,3,1) substr(h,4,1) substr(h,4,1); return h }
function rgb(h, a){ h=expand(toupper(h)); a[1]=h2(substr(h,2,2)); a[2]=h2(substr(h,4,2)); a[3]=h2(substr(h,6,2)) }
function chan(c){ c=c/255; return c<=0.03928 ? c/12.92 : ((c+0.055)/1.055)^2.4 }
function lum(h,   a){ rgb(h,a); return 0.2126*chan(a[1]) + 0.7152*chan(a[2]) + 0.0722*chan(a[3]) }
function ratio(f,b,   lf,lb,hi,lo){ lf=lum(f); lb=lum(b); hi=(lf>lb?lf:lb); lo=(lf>lb?lb:lf); return (hi+0.05)/(lo+0.05) }
function nearest(h,   a,b,i,d,best,bd){ rgb(h,a); bd=1e9; for(i=1;i<=np;i++){ rgb(pal[i],b); d=(a[1]-b[1])^2+(a[2]-b[2])^2+(a[3]-b[3])^2; if(d<bd){bd=d;best=pal[i]} } return best }
function nearname(h,   n){ n=nearest(h); return (n in accent_owner) ? n " (" accent_owner[n] "\047s product accent)" : n }
function err(dim,msg){ if(json){ printf "ERROR [%s] %s\n", dim, msg > "/dev/stderr" } else { printf "ERROR [%s] %s\n", dim, msg }; e[dim]++ }
function warn(dim,msg){ if(json){ printf "WARNING [%s] %s\n", dim, msg > "/dev/stderr" } else { printf "WARNING [%s] %s\n", dim, msg }; w[dim]++ }
function quotectx(s){ return (s ~ /never|use instead|forbidden|class="no"|class="ba bad"/) }

BEGIN{
  np=split(palette, pal, " ")
  nr=split(radii, rad, " ")
  nb=split(bps, bp, " ")
  na=split(accents, arows, "\036")
  for(i=1;i<=na;i++){ m=split(arows[i], akv, "|"); if(m>=2) accent_owner[akv[1]]=akv[2] }
  ndp=split(docpairs, dprows, "\036")
  for(i=1;i<=ndp;i++){ m=split(dprows[i], dpkv, "|"); if(m>=3) docclass[dpkv[1] "|" dpkv[2]] = tolower(dpkv[3]) }
  nf=split(forbidden, frows, "\036")
  for(i=1;i<=nf;i++){ split(frows[i], kv, "\t"); fterm[i]=kv[1]; falt[i]=kv[2] }
  nt=split(terms, trows, "\036")
  for(i=1;i<=nt;i++){ split(trows[i], tkv, "\t"); tcanon[i]=tkv[1]; tsyn[i]=tkv[2] }
  nprod=split(pnames, prodrows, "\034")
  npn=0; for(i=1;i<=nprod;i++) if(prodrows[i]!="") prodnames[++npn]=prodrows[i]; nprod=npn
  blockstart=0; block=""
}

{
  line=$0
  # ── collect custom properties (one-level var resolution) ──
  tmp=line
  while(match(tmp, /--[A-Za-z0-9-]+:[ ]*#[0-9a-fA-F]{3,6}/)){
    decl=substr(tmp, RSTART, RLENGTH)
    split(decl, dkv, ":"); gsub(/ /,"",dkv[2])
    vars[dkv[1]] = toupper(expand(dkv[2]))
    tmp=substr(tmp, RSTART+RLENGTH)
  }

  # ── color: hex literals vs palette (with exclusions) ──
  clean=line
  gsub(/url\([^)]*\)/, "", clean)
  gsub(/data:[^"'\''() ]*/, "", clean)
  gsub(/--[A-Za-z0-9-]+:[ ]*#[0-9a-fA-F]+/, "", clean)  # var defs already palette-checked as literals below would dup
  tmp=clean
  while(match(tmp, /#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}[^0-9a-fA-F]/)){
    hx=substr(tmp, RSTART, RLENGTH); sub(/[^0-9a-fA-F#]$/, "", hx)
    uhx=toupper(expand(hx)); found=0
    for(i=1;i<=np;i++) if(pal[i]==uhx){found=1;break}
    if(!found) err("color", "line " NR ": " hx " is not in the palette. Did you mean " nearname(uhx) "?")
    else if(product!="" && (uhx in accent_owner) && accent_owner[uhx]!=product)
      warn("color", "line " NR ": " uhx " is " accent_owner[uhx] "\047s product accent — product accents mark products, not " product " UI (products/" product "/colors.md).")
    tmp=substr(tmp, RSTART+RLENGTH)
  }
  # var definitions are also brand values — check them too
  tmp=line
  while(match(tmp, /--[A-Za-z0-9-]+:[ ]*#[0-9a-fA-F]{3,6}/)){
    decl=substr(tmp, RSTART, RLENGTH); split(decl, dkv, ":"); gsub(/ /,"",dkv[2])
    uhx=toupper(expand(dkv[2])); found=0
    for(i=1;i<=np;i++) if(pal[i]==uhx){found=1;break}
    if(!found) err("color", "line " NR ": " dkv[2] " is not in the palette. Did you mean " nearest(uhx) "?")
    tmp=substr(tmp, RSTART+RLENGTH)
  }

  # ── JSX inline style contrast ──
  if(line ~ /style[ ]*=[ ]*\{\{/ && line !~ /\/\*.*\*\// && line !~ /<!-- /){
    jsxfg=""; jsxbg=""
    if(match(line, /color:[ ]*"#[0-9a-fA-F]{3,6}"/)){
      c=substr(line, RSTART, RLENGTH)
      gsub(/color:[ ]*"/, "", c); gsub(/"/, "", c)
      jsxfg=toupper(expand(c))
    }
    if(match(line, /background(Color)?:[ ]*"#[0-9a-fA-F]{3,6}"/)){
      c=substr(line, RSTART, RLENGTH)
      sub(/background(Color)?:[ ]*"/, "", c); gsub(/"/, "", c)
      jsxbg=toupper(expand(c))
    }
    if(jsxfg!="" && jsxbg!=""){
      r=ratio(jsxfg,jsxbg)
      key=jsxfg "|" jsxbg; cls=(key in docclass) ? docclass[key] : ((jsxbg "|" jsxfg) in docclass ? docclass[jsxbg "|" jsxfg] : "")
      if(cls ~ /decorative/)
        err("color", "line " NR ": " jsxfg " on " jsxbg " is " sprintf("%.2f",r) ":1 — documented decorative-only pair (colors.md Contrast Pairings): never words.")
      else if(cls ~ /label|display/){
        if(r<3.0) err("color", "line " NR ": " jsxfg " on " jsxbg " is " sprintf("%.2f",r) ":1 — below the 3.0:1 labels minimum (colors.md Contrast Pairings).")
      }
      else if(cls ~ /reading/){
        if(r<4.5) err("color", "line " NR ": " jsxfg " on " jsxbg " is " sprintf("%.2f",r) ":1 — below the 4.5:1 reading minimum (colors.md Contrast Pairings).")
      }
      else if(r<3.0) err("color", "line " NR ": " jsxfg " on " jsxbg " is " sprintf("%.2f",r) ":1 — below the 3.0:1 labels minimum (colors.md Contrast Pairings).")
      else if(r<4.5) warn("color", "line " NR ": " jsxfg " on " jsxbg " is " sprintf("%.2f",r) ":1 — labels & display only; verify the pair class for reading copy (4.5:1).")
    }
  }
  # ── rule-block accumulation for contrast ──
  if(line ~ /{/ && blockstart==0){ blockstart=NR; block="" }
  if(blockstart){ block=block " " line }
  if(line ~ /}/ && blockstart){
    fg=""; bg=""
    if(match(block, /[^-a-z]color:[ ]*[^;}]*/)){
      v=substr(block, RSTART, RLENGTH); sub(/^[^:]*:[ ]*/, "", v); fg=resolve(v)
    }
    if(match(block, /background(-color)?:[ ]*[^;}]*/)){
      v=substr(block, RSTART, RLENGTH); sub(/^[^:]*:[ ]*/, "", v); bg=resolve(v)
    }
    if(fg!="" && bg!=""){
      r=ratio(fg,bg)
      key=fg "|" bg; cls=(key in docclass) ? docclass[key] : ((bg "|" fg) in docclass ? docclass[bg "|" fg] : "")
      if(cls ~ /decorative/)
        err("color", "line " blockstart ": " fg " on " bg " is " sprintf("%.2f",r) ":1 — documented decorative-only pair (colors.md Contrast Pairings): never words.")
      else if(cls ~ /label|display/){
        if(r<3.0) err("color", "line " blockstart ": " fg " on " bg " is " sprintf("%.2f",r) ":1 — below the 3.0:1 labels minimum (colors.md Contrast Pairings).")
      }
      else if(cls ~ /reading/){
        if(r<4.5) err("color", "line " blockstart ": " fg " on " bg " is " sprintf("%.2f",r) ":1 — below the 4.5:1 reading minimum (colors.md Contrast Pairings).")
      }
      else if(r<3.0) err("color", "line " blockstart ": " fg " on " bg " is " sprintf("%.2f",r) ":1 — below the 3.0:1 labels minimum (colors.md Contrast Pairings).")
      else if(r<4.5) warn("color", "line " blockstart ": " fg " on " bg " is " sprintf("%.2f",r) ":1 — labels & display only; verify the pair class for reading copy (4.5:1).")
    }
    blockstart=0; block=""
  }

  # ── layout: spacing scale + breakpoints ──
  if(line ~ /(padding|margin|gap)[a-z-]*[ ]*:/ && line !~ /--/){
    tmp=line
    while(match(tmp, /[0-9]+px/)){
      v=substr(tmp, RSTART, RLENGTH)+0
      if(v % unit != 0){
        lo=int(v/unit)*unit; hi=lo+unit
        warn("layout", "line " NR ": " v "px is outside the spacing scale. Did you mean " lo "px or " hi "px?")
      }
      tmp=substr(tmp, RSTART+RLENGTH)
    }
  }
  if(line ~ /@media/ && match(line, /[0-9]+px/)){
    v=substr(line, RSTART, RLENGTH)+0; found=0
    for(i=1;i<=nb;i++) if(bp[i]==v){found=1;break}
    if(!found && nb>0) warn("layout", "line " NR ": " v "px is not a documented breakpoint (layout.md: adapt within the brand breakpoints).")
  }

  # ── surface: radius scale, overshoot easings, un-tinted shadows ──
  if(line ~ /border[a-z-]*radius[ ]*:/ && line !~ /--radius/){
    # scan only the radius declaration values, not the whole line
    tmp=""
    rest=line
    while(match(rest, /border[a-z-]*radius[ ]*:[ ]*[^;}]*/)){
      tmp=tmp " " substr(rest, RSTART, RLENGTH)
      rest=substr(rest, RSTART+RLENGTH)
    }
    while(match(tmp, /[0-9]+px|50%/)){
      v=substr(tmp, RSTART, RLENGTH)
      if(v!="50%"){
        vn=v+0; found=0
        for(i=1;i<=nr;i++) if(rad[i]==vn"px"){found=1;break}
        if(!found && vn!=999){
          lo=0; hi=99999
          for(i=1;i<=nr;i++){ rv=rad[i]+0; if(rv<vn && rv>lo) lo=rv; if(rv>vn && rv<hi) hi=rv }
          warn("surface", "line " NR ": " vn "px is off the radius scale. Did you mean " lo "px or " hi "px?")
        }
      }
      tmp=substr(tmp, RSTART+RLENGTH)
    }
  }
  if(match(line, /cubic-bezier\([^)]*\)/)){
    cb=substr(line, RSTART, RLENGTH)
    gsub(/cubic-bezier\(|\)/, "", cb); n=split(cb, prm, ",")
    over=0
    for(i=1;i<=n;i++){ gsub(/ /,"",prm[i]); if(prm[i]+0 < -0.0001 || prm[i]+0 > 1.0001) over=1 }
    if(over) warn("surface", "line " NR ": cubic-bezier with overshoot parameters — brand motion settles, it never bounces (components.md).")
  }
  if(line ~ /(bounce|elastic|ease-.*-back)/ && line ~ /(transition|animation)/)
    warn("surface", "line " NR ": bounce/elastic easing — brand motion settles, it never bounces (components.md).")
  if(line ~ /box-shadow[ ]*:/ && (line ~ /#000([^0-9a-fA-F]|$)/ || line ~ /rgba\(0,[ ]*0,[ ]*0/))
    warn("surface", "line " NR ": shadow uses pure black. Brand shadows are ink-tinted (components.md Shadow Recipes).")

  # ── voice: forbidden terms, terminology, product casing ──
  if(!quotectx(line)){
    for(i=1;i<=nf;i++){
      if(fterm[i]!="" && tolower(line) ~ ("(^|[^a-z])" tolower(fterm[i]))){
        err("voice", "line " NR ": \"" fterm[i] "\" is a forbidden term. Use \"" falt[i] "\" instead.")
      }
    }
    for(i=1;i<=nt;i++){
      if(tsyn[i]!="" && tolower(line) ~ ("(^|[^a-z])" tolower(tsyn[i]))){
        match(tolower(line), "(^|[^a-z])" tolower(tsyn[i]))
        warn("voice", "line " NR ": \"" substr(tolower(line), RSTART+1, RLENGTH-1) "\" — use the canonical term \"" tcanon[i] "\" (voice.md Terminology).")
      }
    }
    if(nprod>0){
      tmp=tolower(line)
      lref=line
      prodpat="("
      for(i=1;i<=nprod;i++){ prodpat = prodpat (i>1?"|":"") prodnames[i] }
      prodpat = prodpat ")"
      while(match(tmp, "(^|[^a-z])" prodpat "($|[^a-z])")){
        seg=substr(lref, RSTART, RLENGTH)
        gsub(/[^A-Za-z]/, "", seg)
        if(seg!="") warn("voice", "line " NR ": \"" seg "\" — product names are lowercase, always (voice.md).")
        tmp=substr(tmp, RSTART+RLENGTH)
        lref=substr(lref, RSTART+RLENGTH)
      }
    }
  }
}

function resolve(v,   m){
  gsub(/^[ ]+|[ ;}!].*$/, "", v)
  if(v ~ /^var\(/){ gsub(/^var\(|\).*$/, "", v); gsub(/[, ].*$/, "", v); return (v in vars) ? vars[v] : "" }
  if(v ~ /^#[0-9a-fA-F]+$/) return toupper(expand(v))
  return ""
}

END{
  if(json){
    printf "{\"tool\":\"check\",\"ok\":%s,\"data\":{\"dimensions\":{", (e["color"]+e["layout"]+e["surface"]+e["voice"]==0?"true":"false")
    printf "\"color\":{\"errors\":%d,\"warnings\":%d},", e["color"]+0, w["color"]+0
    printf "\"layout\":{\"errors\":%d,\"warnings\":%d},", e["layout"]+0, w["layout"]+0
    printf "\"surface\":{\"errors\":%d,\"warnings\":%d},", e["surface"]+0, w["surface"]+0
    printf "\"voice\":{\"errors\":%d,\"warnings\":%d}", e["voice"]+0, w["voice"]+0
    printf "}},\"error\":\"\"}\n"
  } else {
    printf "\n--- petals check (deterministic) ---\n"
    printf "Colors:   %d error(s), %d warning(s)\n", e["color"]+0,  w["color"]+0
    printf "Layout:   %d error(s), %d warning(s)\n", e["layout"]+0, w["layout"]+0
    printf "Surface:  %d error(s), %d warning(s)\n", e["surface"]+0, w["surface"]+0
    printf "Voice:    %d error(s), %d warning(s)\n", e["voice"]+0,  w["voice"]+0
    printf "Typography: agent dimension — run via the skill\n"
    te = e["color"]+e["layout"]+e["surface"]+e["voice"]
    tw = w["color"]+w["layout"]+w["surface"]+w["voice"]
    if(te==0) printf "Result: PASS (%d warning(s) to review)\n", tw
    else      printf "Result: FAIL — %d error(s) to fix, %d warning(s) to review.\n", te, tw
  }
  exit (e["color"]+e["layout"]+e["surface"]+e["voice"] > 0 ? 1 : 0)
}
' "$TARGET"
AWK_EXIT=$?

# -- fix mode ----------------------------------------------------------------
if [ "$FIX_MODE" = 1 ]; then
  # Re-run check with the original (pre-fix) file to get clean parseable output
  FIX_TMP=$(mktemp /tmp/check-fix-XXXXXX)
  trap "rm -f '$FIX_TMP'" EXIT
  bash "$0" "$TARGET" --brand "$BRAND" ${PRODUCT:+--product "$PRODUCT"} > "$FIX_TMP" 2>&1 || true

  # Back up the original file
  cp "$TARGET" "$TARGET.petals.bak"
  echo "Backup: $TARGET.petals.bak"

  FIXED=0

  # -- Color fixes: "ERROR [color] line N: #BAD is not in the palette. Did you mean #GOOD ...?"
  sed -n 's/.*ERROR \[color\] line \([0-9]*\): \(#[0-9A-Fa-f]\{6\}\) is not in the palette. Did you mean \(#[0-9A-Fa-f]\{6\}\).*/\1 \2 \3/p' "$FIX_TMP" | while read -r lineno badhex goodhex; do
    sed -i '' "${lineno}s/${badhex}/$(echo "$goodhex" | tr '[:lower:]' '[:upper:]')/g" "$TARGET"
    echo "Fixed color line $lineno: $badhex -> $goodhex"
    FIXED=$((FIXED+1))
  done

  # -- Spacing fixes: "WARNING [layout] line N: Xpx is outside the spacing scale. Did you mean Ypx or Zpx?"
  sed -n 's/.*WARNING \[layout\] line \([0-9]*\): \([0-9]*\)px is outside the spacing scale. Did you mean \([0-9]*\)px or.*/\1 \2px \3px/p' "$FIX_TMP" | while read -r lineno badval goodval; do
    sed -i '' "${lineno}s/${badval}/${goodval}/g" "$TARGET"
    echo "Fixed spacing line $lineno: $badval -> $goodval"
    FIXED=$((FIXED+1))
  done

  # -- Voice fixes: "ERROR [voice] line N: "TERM" is a forbidden term. Use "REPLACEMENT, ..." instead."
  # The replacement may contain commas; we take the first suggestion.
  grep -oE 'ERROR \[voice\] line [0-9]+: "[^"]+" is a forbidden term. Use "[^"]+" instead.' "$FIX_TMP" | while IFS= read -r vline; do
    lineno=$(echo "$vline" | sed -E 's/.*line ([0-9]+):.*/\1/')
    term=$(echo "$vline" | sed -E 's/.*"([^"]+)" is a forbidden term.*/\1/')
    repl_all=$(echo "$vline" | sed -E 's/.*Use "([^"]+)".*/\1/')
    first_repl=$(echo "$repl_all" | cut -d',' -f1 | sed 's/^ *//')
    if [ -n "$lineno" ] && [ -n "$term" ] && [ -n "$first_repl" ]; then
      perl -i -pe "s/\Q${term}\E/${first_repl}/gi if \$. == ${lineno}" "$TARGET"
      echo "Fixed voice line $lineno: \"$term\" -> \"$first_repl\""
      FIXED=$((FIXED+1))
    fi
  done

  echo "Auto-fix applied."
fi

exit $AWK_EXIT
