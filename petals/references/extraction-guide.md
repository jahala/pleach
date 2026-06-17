# Extraction Guide — `/petals init` Process

This document defines the structured process for the `/petals init <folder | url>` subcommand. Follow these steps in order. Deviate only when you encounter an edge case documented in Section 7.

## 1. Asset Discovery

Scan the source. If the source is a URL, proceed to §2a (Website Extraction). If the source is a local folder, catalog every file by type:

```
Expected types and how to handle them:
- .md, .txt, .html → Read as text
- .json, .yaml, .yml → Parse as structured data
- .css, .scss → Parse design tokens
- .svg → Read text content, then copy verbatim to assets/
- .png, .jpg, .jpeg, .webp, .gif → Copy verbatim to assets/
- .ttf, .woff, .woff2 → Catalog metadata (family, weight from filename), copy to assets/
- .pdf → Read with agent's native vision capability
```

Build a file inventory. Note which file types are present and which expected brand dimensions (colors, typography, voice, identity, assets) each file might contain.

For URL sources, skip to §2a — the agent navigates to the page and extracts from the live DOM rather than from files on disk.

## 2. Asset-Type Routing

Route each asset to the best native capability:

| Asset Type | Tool | What to Extract |
|------------|------|----------------|
| PDF | Agent vision/Read | Colors, fonts, voice rules, identity, logo usage guidelines |
| Markdown | Read | Parse sections for colors, typography, voice, identity |
| JSON | Parse | Extract structured design tokens, color values, font specs |
| CSS/SCSS | Parse | Extract custom properties, font declarations, color variables |
| SVG/PNG/JPG | Bash (`cp`) | Copy verbatim to `.brand/assets/` |
| Font files | Bash (`cp`) | Copy to `.brand/assets/`; catalog family and weight from filename |

## 2a. Website Extraction

When the source is a URL, the agent navigates to the live page and extracts
brand values from the rendered DOM. This is a folder of a different kind —
the page IS the brand asset, rendered.

**Step-by-step:**

1. **Navigate** — use Playwright MCP (`browser_navigate`) to load the URL.
   Wait for the page to settle (fonts loaded, CSS applied).

2. **Snapshot** — capture the accessibility tree (`browser_snapshot`) for
   copy text and structural context. Take a full-page screenshot for visual
   reference.

3. **Extract colors** — use `browser_evaluate` to read computed CSS values:
   ```js
   () => {
     const styles = getComputedStyle(document.documentElement);
     const vars = [];
     // Collect all CSS custom properties that look like color tokens
     for (const prop of Array.from(document.styleSheets)
       .flatMap(s => { try { return [...s.cssRules] } catch { return [] } })
       .filter(r => r.selectorText === ':root')
       .flatMap(r => [...r.style])
       .filter(p => p.startsWith('--'))) {
       vars.push({ prop, value: styles.getPropertyValue(prop) });
     }
     // Also grab explicit colors from key elements
     const body = getComputedStyle(document.body);
     return {
       customProperties: vars,
       bodyColor: body.color,
       bodyBackground: body.backgroundColor,
       links: getComputedStyle(document.querySelector('a')).color,
     };
   }
   ```
   Each resolved hex/rgb value is **explicit** — `getComputedStyle` returns
   calculated values, not inferred ones. The explicit-only policy (§3) holds.

4. **Extract typography** — read rendered font stacks:
   ```js
   () => {
     const h1 = document.querySelector('h1');
     const body = getComputedStyle(document.body);
     return {
       headingFont: h1 ? getComputedStyle(h1).fontFamily : null,
       headingWeight: h1 ? getComputedStyle(h1).fontWeight : null,
       headingSize: h1 ? getComputedStyle(h1).fontSize : null,
       bodyFont: body.fontFamily,
       bodyWeight: body.fontWeight,
       bodySize: body.fontSize,
     };
   }
   ```

5. **Extract voice** — read visible page copy from the accessibility snapshot
   and page text (WebFetch). Identify headlines, CTAs, body copy, and error
   messages. The explicit-only policy applies: capture what the page actually
   says; never invent a tone description from inference.

6. **Extract identity** — read the page `<title>`, meta description, and
   visible brand name from headers/nav. Capture the favicon URL and download
   it via `browser_evaluate` or a direct fetch.

7. **Copy assets** — download the favicon, logo images, and any visible brand
   marks to `.brand/assets/`. Use the page's own filenames where available.

8. **Flag gaps** — computed styles return what's rendered, not what's
   documented. A page may use a font without declaring it as the brand font.
   Flag: `[FLAG: website-source] Values extracted from rendered page at <url>.
   These are what the site USES, not necessarily the documented brand. Review
   before treating as canonical.`

The output is the same `.brand/` directory structure — website extraction is
a source adapter, not a different output format. Synthesis into templates (§5)
and ambiguity detection (§4) apply unchanged.

## 3. Explicit-Only Extraction Policy

**CRITICAL RULE: Never infer. Never guess. Never approximate.**

When extracting from source materials:

- **Color values** — only write a hex, RGB, or CMYK value if it is explicitly stated as a color specification in the source. A color name alone ("Teal", "Warm Orange", "Dark") is NOT a color value. If the source says "Primary: Teal" without providing a hex code, flag it as missing. Never use vision to sample a color from an image or swatch.
- **Typography** — only write a font weight if it is explicitly stated. "Open Sans" without a weight is incomplete. "Bold" without a numeric weight (700) is acceptable if the source uses standard weight names. "Bigger" or "smaller" without a specific size is incomplete.
- **Voice rules** — only write forbidden terms and before/after examples if they are explicitly provided in the source. A tone description ("professional but approachable") without specific rules is guidance, not structured data.
- **Identity** — only write a brand name, tagline, or mission if explicitly stated. Never invent these from context or inference.

## 4. Ambiguity Detection

Flag every gap. A flagged gap is better than a guessed value.

| Gap Type | Detection Rule | Flag Format |
|----------|---------------|-------------|
| Missing hex | Color name without hex/rgb/cmyk value | `[FLAG: color-<role>] No explicit hex value for <role> ("<name>"). Provide hex code.` |
| Missing weight | Font name without weight | `[FLAG: typography-weight] "<font>" specified without weight. Provide numeric weight.` |
| Missing size | Font without size | `[FLAG: typography-size] No size specified for <role>. Provide px or rem value.` |
| Vague voice | Tone description without rules | `[FLAG: voice-examples] No before/after examples provided. Add examples to make tone actionable.` |
| Vague voice | No forbidden terms | `[FLAG: voice-terms] No forbidden terms list. Add terms to avoid.` |
| Contradiction | Two different values for same field | `[FLAG: conflict-<field>] Two values found: "<A>" and "<B>". Resolve and re-run.` |
| Empty folder | Source folder contains no files | Error: Source folder is empty. No `.brand/` created. |

## 5. Synthesis into Templates

For each output file, read the corresponding template from `petals/templates/`:

| Output File | Template |
|-------------|----------|
| `.brand/DESIGN.md` | `petals/templates/DESIGN.md` |
| `.brand/colors.md` | `petals/templates/colors.md` |
| `.brand/typography.md` | `petals/templates/typography.md` |
| `.brand/voice.md` | `petals/templates/voice.md` |
| `.brand/identity.md` | `petals/templates/identity.md` |
| `.brand/components.md` | `petals/templates/components.md` |
| `.brand/layout.md` | `petals/templates/layout.md` |

### 5a-pre. Product layers (multi-product organizations)

When the source material describes a brand FAMILY (an organization plus named products), write the shared truth to the umbrella files and each product's deltas to `.brand/products/<product>/` — accent claim, mark, tagline, product terminology. Deltas only; never copy umbrella values down. Single-brand sources stay flat.

### 5a. Derived machine views

After the templates are populated, emit two generated views (never templates — they are derived from the markdown, and the markdown stays canonical):

- `.brand/tokens.css` — every brand value as a CSS custom property, using the brand's own token prefix (take it from the CSS custom-properties block in colors.md when one exists; otherwise derive it from the brand name, e.g. `--acme-*`). Colors, font stacks, spacing, radius, strokes, shadows, motion. Projects import it and reference variables instead of hard-coding values.
- `.brand/tokens.json` — the same values in W3C design-tokens shape (`{ "$value", "$type" }` groups: color, fontFamily, space, layout, radius, stroke, shadow, motion). Build tools and Tailwind/theme configs consume this directly.

Skip a token when its source value was flagged rather than extracted — a generated view must not launder a guess into a value. Regenerate both files on every `/petals update` by running `bash petals/scripts/export-tokens.sh`.

Replace each `{{PLACEHOLDER}}` in the template with the extracted value. For placeholders where no explicit value was found:
- If the field is optional (metadata, visual theme attributes), write "not specified" or remove the line.
- If the field is critical (primary hex, heading font), write the appropriate flag (see Section 4).

## 6. Asset Copy

Copy all recognized asset files byte-for-byte to `.brand/assets/`:

```bash
mkdir -p .brand/assets/
# For each asset file in source:
cp <source-path> .brand/assets/<filename>
```

Asset files include: `.svg`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.ttf`, `.woff`, `.woff2`, `.ico`.

Verify each copy is byte-identical to the source. Use `diff` or `cmp` to confirm.

## 7. Edge Cases

### 7.1 Empty source folder
Stop immediately. Report: "Source folder is empty. No `.brand/` created." Do not create any output.

### 7.2 Images-only source folder
Copy all image files to `.brand/assets/`. Populate the templates with flags for each missing text-derived field (colors, typography, voice, identity). The output `.brand/` will have populated `assets/` and templates containing only flags.

### 7.3 Contradictory values
If two different values appear for the same field (e.g., "Primary: #FF4D00" on page 3 and "Primary: #E7000B" on page 12), surface both. Write the first occurrence in the template and add a `[FLAG: conflict-<field>]` noting both values and their locations. Do not choose one silently.

### 7.4 Partial information
It is normal and acceptable for some templates to have more flags than values. A `.brand/` with three fully specified files and two flagged ones is more useful than five files full of guesses.

### 7.5 Website-specific edge cases

**URL unreachable.** If the page fails to load (timeout, 404, DNS failure),
stop immediately. Report the error to the user. Do not create any output.

**SPA / JS-heavy page.** Wait for the page to settle after navigation. If
the page requires authentication or renders nothing without JS, flag it:
`[FLAG: website-source] Page at <url> requires JavaScript to render. Extracted
values may be incomplete.`

**No CSS custom properties.** If the page uses no `--*` custom properties,
extract the computed values from key elements (body, h1-h4, a, button) as
the closest approximation of the brand's visual language. Flag every value
with the website-source flag above — these are observed usage, not documented
brand rules.

**Conflicting computed values.** If two elements that should share a color
(e.g., two headings at the same level) have different computed values, flag
the contradiction. Pick the most prominent instance (first occurrence in DOM
order) as the primary value.

### 7.6 (reserved for future edge cases)

## 8. Voice & Tone Extraction

Voice extraction follows the same explicit-only policy but with a critical distinction: when the source provides forbidden terms, you generate before/after examples. When the source does NOT provide forbidden terms, you flag for human enrichment.

### 8.1 When source has explicit forbidden terms

For each forbidden term, generate a before/after example pair across 3-5 contexts:

| Context | Before (uses forbidden term) | After (rewrites without it) |
|---------|------------------------------|-----------------------------|
| Marketing copy | Uses the term in a headline or value prop | Rewrites to be direct and clear |
| UI microcopy | Uses the term in a button or label | Rewrites to be concise and action-oriented |
| Error message | Uses the term in an error description | Rewrites to be helpful and human |

**Example generation rules:**
- The "before" must actually use the forbidden term (not a synonym).
- The "after" must preserve the intended meaning without using the forbidden term.
- The "after" must follow the stated tone (direct, warm, technical, etc.).
- Each pair should illustrate a different context.
- Generate at least 3 pairs, at most 5. One pair per forbidden term is sufficient.

### 8.2 When source has tone description but no forbidden terms

Write the tone description into the voice template. Add this flag:

```
[FLAG: voice-terms] No forbidden terms list in source. Add terms to avoid for actionable voice rules.
```

Do NOT invent forbidden terms from the tone description.

### 8.3 When source has no voice information at all

Add this flag to the voice output:

```
[FLAG: voice-missing] No voice or tone information found in source. Define personality traits, tone, and forbidden terms.
```

### 8.4 Populating the voice template

When filling `templates/voice.md`:
- Personality traits come directly from source text.
- Forbidden terms list comes from explicit source statements (not inferred).
- Before/after examples are generated ONLY from explicit forbidden terms.
- Grammar rules come directly from source text.
- Context-specific adaptations come from source text where available; otherwise flagged.

## 9. Constraints

- **Use the tools the agent has** — For file-based sources, use the agent's native capabilities: Read, vision, Bash (`cp`, `mkdir`, `diff`). For URL sources (§2a), the agent navigates with its installed browser tools (Playwright MCP) and reads page text with WebFetch. These are MCP tools the agent already has — nothing is installed and no external API key is needed. Do not invoke tools the agent does not already carry.
- **No color inference** — Never use vision to extract a hex value from an image. Colors must come from explicit text in the source or computed CSS values from `getComputedStyle`. A color name alone ("Teal", "Warm Orange") without a hex is still not a color value.
- **No value invention** — If the source doesn't state it, don't write it. "Not specified" is the correct answer for missing data. For website sources, computed values ARE explicit — `getComputedStyle` returns calculated RGB values from the browser's layout engine, not estimates. But they represent what the site renders, not necessarily the documented brand — flag them accordingly.
- **Templates are the schema** — The template files define the output format. Follow them. Do not add or remove sections.
