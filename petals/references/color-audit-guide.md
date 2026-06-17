# Color Audit Guide

This guide documents the structured process for auditing a file's color usage against the brand palette. The canonical source for color values is `.brand/colors.md`.

## Process

### 1. Build the Palette

Read `.brand/colors.md` and extract every hex color value. The palette includes:
- Primary Palette: Primary, Accent, Background, Text
- Semantic Roles: Error, Success, Warning, Info
- Light/Dark Mode Variants: Each role's light and dark variants
- Any additional hex values in the CSS custom properties section

Store these as a set for exact-match comparison. Normalize to uppercase for case-insensitive matching (e.g., `#2f99a4` and `#2F99A4` are the same color).

### 2. Scan the Target File

Use regex to find all hex color patterns in the target file:

```
#[0-9a-fA-F]{3}\b         # #rgb
#[0-9a-fA-F]{6}\b         # #rrggbb
#[0-9a-fA-F]{8}\b         # #rrggbbaa (if the brand uses 8-digit hex)
```

Scan line by line. Record each match with its line number and the full matched value.

### 3. Exclude False Positives

Before matching against the palette, filter out matches that appear in contexts where hex values are not color declarations:

- **Data URIs**: Matches inside `url("data:image/...` strings. These are encoded image data, not style declarations.
- **Base64 strings**: Matches inside base64-encoded strings. Base64 uses hex-like characters but encodes binary data.
- **URLs**: Matches inside `url(...)` that reference external resources (fonts, images).
- **Hash references**: Matches like `#id` selector in CSS, or `#anchor` in URLs.

Guideline for context detection:
- If a hex pattern appears immediately after `data:image/`, skip it.
- If a hex pattern appears within a string that is >100 characters and contains only base64 characters (`[A-Za-z0-9+/=]`), skip it.
- If a hex pattern appears inside `url(...)` that does not start with `data:`, skip it.

### 4. Match Against Palette

For each remaining match, normalise the case (uppercase) and check against the palette set:

- **Match found**: No violation. Skip.
- **No match**: This is a color error. Proceed to step 5.

### 5. Find the Closest Palette Match

For each violation, find the palette color closest to the violating hex. The closest match is the one with the smallest perceptual distance.

Compute distance using the Euclidean distance in RGB space:

```
Given hex #RRGGBB:
  R1 = int(RR, 16), G1 = int(GG, 16), B1 = int(BB, 16)
For each palette color:
  R2, G2, B2 = palette color components
  distance = sqrt((R1-R2)^2 + (G1-G2)^2 + (B1-B2)^2)
```

Return the palette color with the smallest distance. If multiple palette colors have the same distance, prefer the Primary color, then the one most frequently used in the palette.

For 3-digit hex (#rgb), expand to 6-digit before comparison: `#RGB` becomes `#RRGGBB`.

### 6. Classify the Violation

All color mismatches are **errors** (must fix). There are no warnings for color violations. A single off-palette hex means the check does not pass.

### 7. Report Results

For each violation, report:
- **Dimension**: `color`
- **Severity**: `error`
- **Line**: The line number where the violation was found
- **Found**: The hex value found in the file
- **Suggested**: The closest palette match

Format:
```
ERROR [color] line 42: #3B82F6 is not in the palette. Did you mean #2F99A4?
```

If zero violations:
```
PASS [color] All colors match the brand palette.
```

### 8. Contrast Pairings (legibility is part of color)

If `.brand/colors.md` has a "Contrast Pairings" section:

1. Extract the pair-class minimums (reading / labels & display / decorative) and any documented pair classifications.
2. Find places where a text color and its background are both statically knowable: a rule or inline style setting both `color` and `background`(-color). Resolve `var()` references against the file's `:root`. Skip pairs that cannot be resolved.
3. Compute the WCAG 2.x contrast ratio. Classify the text: body-size prose -> reading; short labels, tags, kickers, display-size (>= 24px) type -> labels & display.
4. Below the class minimum -> **error**. A color documented as "labels & display only" or "decorative only" used for body copy -> **error**, naming the documented class.

```
ERROR [color] line 18: #C9923C on #F0EDE1 is 2.34:1 — below the labels minimum of 3.0:1. Decorative only on light surfaces (see Contrast Pairings).
```

### 9. Chart Categorical Series

If `.brand/colors.md` has a "Data Visualization" section with a categorical series order, hex literals used in chart configs should follow the documented order. A categorical series that does not follow the documented order is a **warning**:

```
WARNING [color] line 32: chart categorical series does not follow the Data Visualization order (colors.md). Expected: Growth #357E2C, Sunlight #E89227, Sky #4E88A6, ...
```

This step is advisory — it helps the agent check, but cases where only a subset of the categorical colors are used are not flagged.
### Reference

- Canonical color source: `.brand/colors.md` (palette + Contrast Pairings + Data Visualization)
- This guide is used by: `/petals check <file>` (color audit dimension)
