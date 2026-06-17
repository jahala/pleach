---
name: petals
description: >-
  Brand compliance and design system skill. Use this skill when:
  - Building UI, components, layouts, landing pages, or any visual output
  - Writing copy, headlines, CTAs, microcopy, error messages, or marketing text
  - Checking if generated code/copy is on-brand (colors match palette, typography follows hierarchy, voice follows rules)
  - Extracting brand assets into a structured .brand/ directory from source files (PDFs, images, markdown, JSON)
  - Setting up or updating a project's brand context from a central brand repository
  - Any creative work where brand consistency matters — colors, typography, voice, UI, copy, compliance
---

# petals — Brand Intelligence for Agents

## Auto-Trigger Conditions

This skill activates automatically when an agent:
1. Generates UI code (HTML, CSS, React, Vue, Svelte, Tailwind, etc.)
2. Writes copy (headlines, CTAs, marketing text, microcopy, error messages)
3. Builds components, layouts, or landing pages
4. References brand assets (logos, color palettes, typography)

When activated, read the relevant `.brand/` file(s) BEFORE generating output:
- UI/visual work → `.brand/DESIGN.md` or `.brand/colors.md`
- Typography decisions → `.brand/typography.md`
- Copywriting → `.brand/voice.md`
- Logo/asset usage → `.brand/assets/` and `.brand/identity.md`

## Hard Validity Rules

These are non-negotiable. Violating any is a brand error.

1. **Colors from palette only** — Every hex value in generated output must match a value defined in `.brand/colors.md`. Never use arbitrary colors, even if they "look similar." In a product context, another product's accent is a warning — accents mark products.
2. **Typography hierarchy** — Heading and body fonts must match `.brand/typography.md` exactly (family, weight, size). No font substitutions.
3. **Logo from assets** — Never invent, approximate, or text-describe a logo. Use files from `.brand/assets/` or skip the logo.
4. **Voice rules** — Generated copy must not contain forbidden terms listed in `.brand/voice.md`. Follow tone, grammar, and vocabulary rules.
5. **Conflict: brand wins** — When brand rules conflict with framework defaults, the brand rules win. Override Tailwind config, CSS resets, and component library defaults to match `.brand/`.

## Where petals lives

petals has two pieces, one lifecycle each:

| Piece | What it is | Where it lives | Lifecycle |
|-------|-----------|---------------|-----------|
| **Skill directory** | SKILL.md, scripts, references, templates | Your platform's skills directory | Install once. Update when petals improves. |
| **Brand directory** | `.brand/` — colors, typography, voice, identity, layout, components | Project root | Fetched from central brand repo. Updates when the brand changes. |

Never put `.brand/` inside the skill directory. Never duplicate the scripts into projects.

### Install (once, anywhere)

petals is a single directory. Install it wherever your agent looks for skills:

| Platform | Install path |
|----------|-------------|
| Claude Code | `~/.claude/skills/petals/` |
| Codex CLI | `~/.codex/skills/petals/` |
| Gemini CLI | `~/.gemini/skills/petals/` |
| Cross-platform | `~/.agents/skills/petals/` (Codex, OpenCode, Gemini) |

Use a symlink — it stays current with the repo:

```bash
ln -s /path/to/petals ~/.claude/skills/petals
```

The agent discovers `SKILL.md` on session start. No project-level setup needed. No copy-paste into every project.

### How scripts are found

All script paths in this document are relative to this SKILL.md file. `scripts/check.sh` means "the `scripts/` directory next to `SKILL.md`" — whether petals was installed globally or per-project. The agent resolves `{skill-root}/scripts/check.sh` from wherever it loaded this file.

The scripts find `.brand/` by walking up from `$PWD` — they don't need to be in the project. `scripts/lib/common.sh` does this automatically.

### CI (the one reason to put petals in a project)

If you want the deterministic check engine in CI, copy or symlink the skill directory into the project before the CI job runs. The scripts don't need a per-project copy otherwise.

## Brand Architecture (umbrella + product layers)

A brand may be one entity (a flat `.brand/` — the zero-config default) or a family: an umbrella brand whose products each carry their own layer.

- **Umbrella**: the shared truth — palette, typography, layout, surface, voice, the organization's identity. Lives at `.brand/*.md`.
- **Product layers**: `.brand/products/<product>/` — deltas only (the product's accent claim, mark, tagline, product terminology). An absent file inherits the umbrella entirely. Never copy umbrella values down.
- **Resolution**: every read resolves umbrella ⊕ product. Product context comes from `--product`, else `.petalsrc`'s `product:` field, else the single directory under `products/`, else flat. Progressive disclosure holds: at most two files per dimension.
- **Cross-product accents**: each product's accent (umbrella Product Accents table) marks THAT product. Literal use of another product's accent in your product's UI is a warning, by name. Off-palette colors near a product accent are suggested with the owner named.
- The book, tokens, and check all operate on the RESOLVED brand; the book names each value's owning layer.

## Subcommand Dispatch

| Command | Description |
|---------|-------------|
| `/petals init <folder>` | Scan folder for brand assets and create `.brand/` directory |
| `/petals init --from <repo-url>` | Fetch `.brand/` from a central brand repository |
| `/petals check [file]` | Audit file against brand rules; if no file, check for brand drift |
| `/petals voice <text>` | Check copy against `.brand/voice.md`; return score and suggestions |
| `/petals color <name>` | Look up a specific color from `.brand/colors.md` |
| `/petals token <format>` | Export design tokens in specified format (css, tailwind, dtcg) |
| `/petals update` | Sync `.brand/` with latest from central, preserving project overrides |
| `/petals logo [variant]` | Return the correct logo asset path for the requested variant |
| `/petals book` | Render `.brand/` as a single self-contained brand-book HTML for human review and sharing |

## Reference Workflow

Load reference files on demand based on the task:

| Task | Load |
|------|------|
| Extracting brand from assets | `references/extraction-guide.md` |
| Populating output templates | `templates/DESIGN.md`, `templates/colors.md`, `templates/typography.md`, `templates/voice.md`, `templates/identity.md`, `templates/components.md`, `templates/layout.md` |
| Auditing colors | `.brand/colors.md`, `references/color-audit-guide.md` |
| Auditing typography | `.brand/typography.md` |
| Auditing layout (spacing/containers/breakpoints) | `.brand/layout.md` |
| Auditing surface (radius/shadow/motion) | `.brand/components.md` |
| Auditing voice | `.brand/voice.md`, `references/voice-guide.md` |
| Auditing output (all dimensions) | `references/color-audit-guide.md`, `references/voice-guide.md`, `.brand/*.md` |
| Rendering the brand book | `references/book-guide.md`, `.brand/*.md` |
| Generating UI | `.brand/DESIGN.md`, `.brand/colors.md`, `.brand/typography.md`, `.brand/components.md` |
| Writing copy | `.brand/voice.md`, `.brand/identity.md` |

Layout and surface audits are self-contained in this document. Color and voice have separate reference guides because of their edge-case density (false-positive exclusions, contrast math, context-dependent tone rules).
## /petals init Workflow

When `/petals init <folder>` is invoked, follow the extraction process documented in `references/extraction-guide.md`. Core principles:

1. **Explicit only** — only write values explicitly stated in source. Never infer hex from color names, weights from font names, or examples from tone descriptions.
2. **Flag ambiguity** — when a value is missing or unclear, flag it in the output with a clear question.
3. **Copy assets verbatim** — use `cp` or equivalent to copy asset files (SVGs, PNGs, JPGs, fonts) to `.brand/assets/`.
4. **Use templates** — populate `templates/*.md` with extracted values to produce `.brand/*.md`.
5. **Use the tools the agent has** — for file-based sources, use the agent's native capabilities: file reading, vision, parsing, Bash. For website URLs, use Playwright MCP (`browser_navigate`, `browser_evaluate`, `browser_snapshot`) and WebFetch — tools the agent already carries. Never install new dependencies. Follow `references/extraction-guide.md` for the full process.
6. **The skill travels with the project** — extraction's second output is the `petals/` directory itself (SKILL.md, references/, templates/, scripts/ including the deterministic check engine), copied into the project so every later session has the full toolchain.

## /petals init --from Workflow (Distribution)

When `/petals init --from <repo-url>` is invoked, the agent connects the project to a central brand repository and fetches `.brand/` into the local project.

### Distribution model

The central brand repository is a git repository with `.brand/` at its root. Projects pull `.brand/` from it — they do not commit `.brand/` themselves. `.brand/` is a cache. `.petalsrc` at the project root records where the brand came from and which version is in use.

```
Central brand repo (github.com/company/brand, tagged v1.2.0)
        |
        |  fetch-brand.sh
        v
Project .brand/  (gitignored — cache, not source)
Project .petalsrc  (committed — source, version, overrides)
```

### Step-by-step process

1. **Check for existing .brand/** — If `.brand/` already exists, warn the user:
   ```
   .brand/ already exists (version v1.1.0 from github.com/company/brand).
   Running init --from will overwrite it. Continue? (y/N)
   ```
   Wait for confirmation. If denied, exit without changes. If `.brand/` does not exist, proceed.

2. **Check for existing .petalsrc** — If `.petalsrc` already exists, do NOT modify it without confirmation. Warn:
   ```
   .petalsrc already exists with source: github.com/other/repo.
   Overwriting will change the brand source. Continue? (y/N)
   ```
   Wait for confirmation.

3. **Run fetch-brand.sh** — Execute the fetch script with the provided repo URL:
   ```bash
   bash scripts/fetch-brand.sh <repo-url> --target .brand
   ```
   The script auto-selects the best strategy (local path, git clone, GitHub API, raw HTTP). If the script exits non-zero, report the error to the user and STOP. Do not create or modify any files.

4. **Record source and version in .petalsrc** — Parse the JSON output from fetch-brand.sh to get the version. Create or update `.petalsrc`:
   ```yaml
   brand:
     source: <repo-url>
     version: <detected-version>   # e.g. v1.1.0
     product: <product-name>       # optional: this project's product context
                                   # in a family brand (resolves products/<name>/)
     overrides: {}
   ```
   When the fetched brand carries `products/`, ask which product this project is (or none, to use the umbrella alone) and record it — the check, book, and tokens resolve against it.
   The `overrides` map starts empty. Users add entries to override specific brand values for this project (see Override format below).

5. **Add .brand/ to .gitignore** — Check if `.gitignore` exists. If not, create it. Append `.brand/` to `.gitignore` if not already present. Use:
   ```bash
   grep -qxF '.brand/' .gitignore 2>/dev/null || echo '.brand/' >> .gitignore
   ```

6. **Verify output** — Confirm the output is correct:
   - `.brand/` directory exists and contains files
   - `.petalsrc` exists with `source`, `version`, and `overrides` fields
   - `.gitignore` contains `.brand/`
   - `git status` does not show `.brand/` as untracked (if in a git repo)

7. **Report summary** — Tell the user:
   ```
   Connected to brand: <repo-url>
   Version: <version>
   Files in .brand/: <count>
   .brand/ is gitignored (cache, not source code)
   ```

## /petals update Workflow (Sync)

When `/petals update` is invoked, the agent syncs the local `.brand/` with the latest version from the central repository while preserving project-level overrides.

### Step-by-step process

1. **Verify the project is connected** — Read `.petalsrc`. If it does not exist or has no `brand.source` field:
   ```
   This project is not connected to a brand source.
   Run /petals init --from <repo-url> first.
   ```
   Stop.

2. **Back up current .brand/** — Before making any changes, back up the current `.brand/` directory:
   ```bash
   cp -r .brand .brand.backup
   ```
   This ensures the current state is preserved if anything fails.

3. **Read current overrides** — Parse `.petalsrc` to extract the `overrides` map. Each override is a flattened key with a dot-separated path:
   ```yaml
   overrides:
     colors.primary: "#custom-hex"    # non-null: preserve this value
     typography.body: null             # null: inherit from central
   ```
   Store these in memory for the merge step.

4. **Run fetch-brand.sh** — Fetch the latest `.brand/` from the central source:
   ```bash
   bash scripts/fetch-brand.sh <source-from-petalrc> --target .brand.incoming
   ```
   Fetch into a temporary directory `.brand.incoming`, NOT directly into `.brand/`. If the script exits non-zero, restore from backup and report the error.

5. **Detect version from incoming** — Read the version from the fetched `.brand.incoming/identity.md` or from the fetch script output. Compare with `.petalsrc` version. If they are the same:
   ```
   Brand is already at the latest version (<version>). Nothing to update.
   ```
   Clean up `.brand.incoming` and `.brand.backup`. Stop.

6. **Merge overrides** — For each override in `.petalsrc`:
   - **Non-null value** (e.g., `colors.primary: "#OVERRIDE"`): Find and replace the corresponding value in `.brand.incoming/` files. The exact replacement strategy depends on the file format:
     - For `.brand/colors.md`: Replace the hex value in the table row and CSS custom property.
     - For `.brand/typography.md`: Replace the font family, weight, or size in the table row.
     - For `.brand/voice.md`: Replace the specific term or rule.
   - **Null value**: Do nothing — the central's current value will be used (it is already in `.brand.incoming/`).

7. **Apply the update** — Replace the live `.brand/` with the merged incoming:
   ```bash
   trash .brand
   mv .brand.incoming .brand
   ```

8. **Update .petalsrc version** — Update the `version` field in `.petalsrc` to the new version tag.

9. **Regenerate the machine views** — `.brand/tokens.css` and `.brand/tokens.json` are derived from the markdown files (see `references/extraction-guide.md` §5a); regenerate both with `bash scripts/export-tokens.sh`. If `.brand/book.html` exists, regenerate it too.

10. **Report the blast radius** — an update is not done until the project knows what it broke. Run `/petals check` against the project's primary UI entry points (or the files checked most recently). Report anything that the NEW brand version flags which the old one did not:
    ```
    Blast radius: 3 files have violations introduced by this update.
      src/components/Hero.tsx — 2 color errors (old primary #4C5E3C)
      …
    ```
    Zero findings reports `Blast radius: clean.`

11. **Clean up** — Remove the backup:
    ```bash
    trash .brand.backup
    ```

12. **Report summary** — Tell the user:
    ```
    Updated brand from <old-version> to <new-version>.
    Preserved <N> override(s): <list of preserved keys>
    Updated <M> inherited values. Blast radius: <clean | N files to fix>.
    ```

## /petals check (Drift Detection)

When `/petals check` is invoked without a file argument, it checks for brand drift — whether the central repository has a newer version than what is cached locally.

### Step-by-step process

1. **Read .petalsrc** — Get the `source` and `version` fields. If `.petalsrc` does not exist:
   ```
   No brand source configured. Run /petals init --from <repo-url> first.
   ```
   Stop.

2. **Fetch central version** — Run fetch-brand.sh in a dry-run mode, or query the source directly:
   - For local paths: Read `.brand/identity.md` from the source directly.
   - For git repos: `git ls-remote --tags <repo-url>` and take the highest semver tag.
   - For GitHub URLs: Use the GitHub API `GET /repos/:owner/:repo/releases/latest` or `GET /repos/:owner/:repo/git/refs/tags`.
   - For raw HTTP: Fetch `identity.md` from raw.githubusercontent.com.

   If the central source is unreachable:
   ```
   Warning: Cannot reach brand source (<source-url>).
   Local .brand/ at version <local-version> is preserved unchanged.
   Error: <specific error>
   ```
   Do not modify any local files. Exit gracefully.

3. **Compare versions** — Compare the local version (from `.petalsrc`) with the central version:
   - If **local == central**: No output. Nothing to report. (No noise when current.)
   - If **local < central**: Report the drift:
     ```
     Brand drift detected.
     Local:  <local-version>
     Central: <central-version>
     Run /petals update to sync.
     ```
   - If **local > central**: This is unusual (local ahead of central). Report:
     ```
     Local brand (<local-version>) is ahead of central (<central-version>).
     This may indicate the central repo was rolled back. Review before updating.
     ```

## /petals check `<file>` (File Audit)

When `/petals check <file>` is invoked with a file argument, the agent audits the file against `.brand/` rules across up to five dimensions: color, typography, layout, surface, and voice. The audit follows progressive disclosure: each dimension only loads the `.brand/` file it needs.

**Deterministic core first.** Run `bash scripts/check.sh <file>` before any agent pass — it covers the pure-math checks (palette hexes, contrast pairs, spacing scale, breakpoints, radius scale, easings, shadows, forbidden terms, terminology, product casing) in milliseconds with zero tokens, in the documented report format. The agent then adds what the script cannot do: the typography dimension (role classification needs context), tone, and dismissing any quoted-context voice hits the script's heuristic missed. The dimension sections below are the SPEC the script implements — consult them when interpreting findings or when the script is unavailable.

### Book Pre-Pass (only for .brand/book.html)

When the target file is `.brand/book.html`, run a staleness check before the regular five-dimension audit. The book is a generated view of `.brand/` — it has no authority of its own. Every CSS value in the book must match the canonical source files.

**Process**:

1. **Read canonical sources**: Load `.brand/colors.md` (CSS custom properties block in the `:root`) and `.brand/typography.md` (font families, font imports). Read the book's `<meta name="source-fingerprint">` tag.

2. **Recompute the fingerprint**: Concatenate all `.brand/*.md` files (plus product layers in `.brand/products/*/*.md` if present) and compute `sha256`. Compare against the book's `source-fingerprint` meta tag.
   - **Match**: Book is current. Proceed to the regular five-dimension audit.
   - **Mismatch or missing**: Report drift:
     ```
   ERROR [book] book.html is stale — fingerprint does not match canonical .brand/ sources.
   Regenerate with /petals book.
     ```
     Exit non-zero. Do not proceed to the five-dimension audit — a stale book needs regeneration, not dimension-by-dimension repair.

3. **Verify CSS :root values** (if fingerprint matches): For each color custom property (`--pp-*`), confirm the hex matches the value in `.brand/colors.md`. For `--font-*` properties, confirm the font family matches `.brand/typography.md`. Mismatches are errors — the book is a view, and every value must come from the canonical files.

### Guard clause

Before any audit, verify the project is configured:

1. Check if `.brand/` directory exists. If not:
   ```
   No brand configured. Run /petals init --from <url> to connect to a central brand repo.
   ```
   Exit non-zero. Do not proceed.

2. If `.brand/` exists, proceed dimension by dimension. Each dimension checks for its specific file and skips gracefully if missing (see per-dimension guard clauses).

### Dimension 1: Color Audit

**Load**: `.brand/colors.md` (only this file — do not load DESIGN.md, typography.md, or voice.md). If `.brand/colors.md` does not exist, skip this dimension and report: `SKIP [color] colors.md not found. Skipping color audit.`

**Process:** Follow `references/color-audit-guide.md` for the full procedure. Summary:
- **Palette**: extract hexes from `.brand/colors.md`
- **Exclusions**: data URIs, base64 strings, URLs
- **Match**: exact hex comparison; closest Euclidean distance for mismatches
- **Contrast**: WCAG ratio against pair-class minimums from colors.md Contrast Pairings
- **Charts**: hex literals in chart configs are already covered by steps 2–5; additionally, a categorical series that does not follow the documented "Data Visualization" order is a **warning**.

If zero color violations: `PASS [color] All colors match the brand palette and pairing minimums.`

### Dimension 2: Typography Audit

**Load**: `.brand/typography.md` (only this file). If `.brand/typography.md` does not exist, skip and report: `SKIP [typography] typography.md not found. Skipping typography audit.`

**Process**:

1. Extract font families from `.brand/typography.md`: heading font and body font (from the "Font Families" table).
2. Read the target file and scan for `font-family` declarations. In CSS, JSX/TSX, and other code files, look for patterns like:
   - `font-family: 'Raleway'` / `fontFamily: 'Raleway'`
   - `font-family: "Open Sans"` / `fontFamily: "Open Sans"`
3. For each `font-family` declaration, determine if the element is a heading or body:
   - Headings: `h1`, `h2`, `h3`, `h4`, `h5`, `h6` elements, or class names containing `heading`, `title`, `headline`
   - Body: `p`, `span`, `div`, `body`, `li`, `a`, `button`, `label`, `input` elements, or class names containing `body`, `text`, `content`, `paragraph`, `copy`
   - If the role is ambiguous (generic `div` or `span` without clear context), default to body-level checking.
4. Check each declaration:
   - **Heading element uses heading font**: No violation.
   - **Heading element uses body font**: Warning (suggest heading font).
   - **Body element uses body font**: No violation.
   - **Body element uses heading font**: **Error** — body text must use the body font.
5. Report typography errors as:
   ```
   ERROR [typography] line <N>: '<found-font>' used for body text. Body must use '<body-font>'.
   ```

If zero typography violations:
```
PASS [typography] Font families match the brand hierarchy.
```

### Dimension 3: Layout Audit

**Load**: `.brand/layout.md` (only this file). If `.brand/layout.md` does not exist, skip and report: `SKIP [layout] layout.md not found. Skipping layout audit.`

Layout governs the space *between* elements — spacing scale, containers, breakpoints, density. (Surface, Dimension 4, governs the finish *of* an element.)

**Process**:

1. Extract from `.brand/layout.md`: the spacing scale (e.g., `4px, 8px, 12px, …`; if expressed as "multiples of N", compute the set of valid multiples), the container max-width(s) and gutter, and the documented breakpoints.
2. Read the target file and scan for `px` values in padding, margin, gap declarations:
   - `padding: <N>px`, `margin: <N>px`, `gap: <N>px`
   - `padding-top`, `padding-bottom`, `margin-left`, etc.
   - JSX equivalents: `padding: <N>`, `marginTop: <N>` (values in px)
3. For each px value, check against the spacing scale:
   - **Matches a scale value (or an exact multiple)**: No violation.
   - **Does not match**: **Warning** (not an error). Find the two nearest scale values and suggest the closest.
4. Scan for content containers (`max-width` on wrapper/container elements): a container width that matches neither the documented container(s) nor a documented reading measure is a **warning** — name the documented value.
5. Scan `@media` query widths: a breakpoint not in the documented set is a **warning** — name the nearest documented breakpoint. (Adapt within the brand's breakpoints rather than inventing new ones.)
6. Report layout warnings as:
   ```
   WARNING [layout] line <N>: <found-value> is outside the <spacing scale|container widths|breakpoints>. Did you mean <closest-documented-value>?
   ```

If zero layout warnings:
```
PASS [layout] Spacing, containers, and breakpoints match the layout rules.
```

### Dimension 4: Surface Audit

**Load**: `.brand/components.md` (only this file). If `.brand/components.md` does not exist, skip and report: `SKIP [surface] components.md not found. Skipping surface audit.`

**Process**:

1. Extract the token tables from `.brand/components.md`: the radius scale, border-stroke widths, shadow recipes (and their stated color policy), and motion tokens (easings, durations).
2. Read the target file and scan for surface declarations:
   - `border-radius: <value>` (and JSX `borderRadius`)
   - `box-shadow: <value>` (and JSX `boxShadow`)
   - `border: <width> …` / `border-width`, `outline` widths
   - `transition: … <duration> <easing>`, `animation: … <duration> <easing>`, `transition-timing-function`, `animation-timing-function`
3. Check each declaration against the tokens:
   - **Radius**: a value not on the radius scale (allowing `999px`/`50%` as radius-full) is a **warning** — suggest the nearest scale value.
   - **Shadow**: a shadow violating the stated color policy (e.g. pure `#000` / un-tinted `rgba(0, 0, 0, …)` where the brand specifies tinted shadows) is a **warning** — name the policy.
   - **Border width**: a width not in the stroke table is a **warning** — suggest the nearest stroke.
   - **Easing**: a bounce/elastic easing (e.g. `cubic-bezier` with an overshoot, `ease-in-out-back`) or any easing/duration far outside the motion tokens is a **warning** — name the brand ease. Anything in the brand's forbidden-motion list is an **error**.
   - Skip values inside data URIs and third-party vendored code, mirroring the color audit's false-positive rules.
4. Report as:
   ```
   WARNING [surface] line <N>: <found-value> is off the <radius|stroke|shadow|motion> tokens. Did you mean <closest-token>?
   ```

If zero surface violations:
```
PASS [surface] Radius, borders, shadows, and motion match the surface tokens.
```

### Dimension 5: Voice Audit (within check)

If the target file contains text content (copy strings, comments with user-facing text, JSX text nodes), also run the voice audit. See `/petals voice` workflow below for the detailed process.

**Load**: `.brand/voice.md` (only if text content is detected — progressive disclosure: skip loading voice.md if the file has no text content).

### Summary Report

After all dimensions complete, print a summary:

```
--- brand check summary ---
Colors:   <N> error(s), <M> warning(s)
Typography: <N> error(s), <M> warning(s)
Layout:   <N> error(s), <M> warning(s)
Surface:  <N> error(s), <M> warning(s)
Voice:    <N> error(s), <M> warning(s)

Result: <PASS (all dimensions clean) | FAIL (<X> error(s) to fix, <Y> warning(s) to review)>
```

Exit 0 if zero errors (warnings alone do not fail the check). Exit non-zero if any errors exist.

## /petals voice `<text-or-file>`

When `/petals voice <text-or-file>` is invoked, the agent audits the provided text or file content against `.brand/voice.md` rules. This can be used standalone or as part of `/petals check <file>`.

### Guard clause

1. Check if `.brand/` directory exists. If not:
   ```
   No brand configured. Run /petals init --from <url> to connect to a central brand repo.
   ```
   Exit non-zero. Do not proceed.

2. Check if `.brand/voice.md` exists. If not:
   ```
   SKIP [voice] voice.md not found. Skipping voice audit.
   ```
   Exit non-zero (missing configuration is a setup issue).

### Determine the input

The argument can be either inline text or a file path:

- **Inline text** (no file extension, or quoted string that does not match an existing file): Audit the text directly.
- **File path** (matches an existing file, or has a known extension like `.txt`, `.md`, `.tsx`, `.jsx`, `.html`): Read the file and audit its text content.

### Process (follows `references/voice-guide.md`)

1. **Load voice rules**: Read `.brand/voice.md` (only this file — do not load DESIGN.md, colors.md, or typography.md). Extract:
   - Forbidden terms from the "Forbidden Terms" table (term + preferred alternative)
   - Canonical terms from the "Terminology" table (term + banned synonyms), plus product-name casing rules
   - Capitalization & microcopy rules (sentence case, verb-first buttons, error shape, punctuation)
   - Tone spectrum rules (formality, warmth, directness for each context)

2. **Determine the context**: Classify the text based on the file type or content:
   - UI code files (`.tsx`, `.jsx`, `.vue`, `.svelte`, `.css`): UI Microcopy context
   - Documentation files (`.md`, `.mdx`): Documentation context
   - Plain text files (`.txt`): Marketing context
   - Inline text (no file): Marketing context

3. **Scan for forbidden terms**: For each forbidden term from the voice guide:
   - Search **case-insensitively** through the text
   - Match exact words and substrings (e.g., "leveraging" contains "leverage")
   - For each match, record: the forbidden term, line number/position, full matched word

4. **Check terminology** (if a "Terminology" table exists): for each banned synonym, search case-insensitively; a match is a **warning** naming the canonical term. A capitalized product name (e.g. "Petals" where the rules say lowercase) is a **warning**.

5. **Check capitalization & microcopy** (if the rules exist): flag as **warnings**:
   - Headings, buttons, or labels in Title Case (two or more consecutive capitalized words that are not proper nouns) where sentence case is required
   - Button labels that are not verb-first or exceed the stated word limit
   - Exclamation marks in interface copy, if forbidden

6. **Check tone rules**: Flag additional patterns:
   - Jargon density: 3+ jargon/buzzword-like terms in close proximity
   - Sentence length: Sentences exceeding 25 words
   - Passive voice: If active voice is required by grammar rules

7. **Provide replacements**: For each forbidden term violation, provide the preferred alternative from the voice guide. For terminology and tone violations, provide the canonical term or a plain-language suggestion.

8. **Report results**:

For each forbidden term violation (error):
```
ERROR [voice] line <N>: "<forbidden-term>" is a forbidden term. Use "<alternative>" instead.
```

For each tone rule violation (warning):
```
WARNING [voice] line <N>: <tone-issue-description>. Consider <suggestion>.
```

If zero violations:
```
PASS [voice] Text follows brand voice guidelines.
```

### Summary

After the audit, print a summary:
```
--- voice check summary ---
Forbidden terms: <N> violation(s)
Tone issues:    <M> warning(s)

Result: <PASS | FAIL (<X> error(s) to fix, <Y> warning(s) to review)>
```

Exit 0 if zero errors (warnings alone do not fail). Exit non-zero if any forbidden term violations exist.

## /petals book

When `/petals book` is invoked, the agent renders `.brand/` as one self-contained HTML page — the brand's human face. The markdown files are for agents; the book is for the person who owns the brand: review the extraction, spot what is wrong, share it with the team.

The book is set in the **project's own brand**, chrome included — its fonts, its palette, its casing, its spacing. petals has no visual identity inside your project; everything it produces there (book, tokens, exemplars) carries yours.

1. **Guard**: if `.brand/` does not exist, report: `No brand configured. Run /petals init first.` and stop.
2. **Read all of `.brand/`** (the one workflow that loads everything — this is a rendering job, not an audit).
3. **Generate `.brand/book.html`** following `references/book-guide.md` — the RESOLVED product brand (umbrella ⊕ product layer), masthead "<product> brand book · a <umbrella> brand", each section kicker naming the owning layer: masthead with the mark and version; one section per brand file (palette with contrast pairings, type specimens, layout ruler, surface tokens with live hover demos, component exemplars built purely from the tokens, voice traits + forbidden terms + before/after, logo with usage rules).
4. **Surface flags**: every `[FLAG: …]` found in the brand files renders as a "needs an answer" card at the top of the book — the owner's review queue.
5. **The book must pass its own check**: palette-only hexes, exact font families, and the project's own casing, terminology, and voice rules. Self-demonstration is the contract.
6. Report: `Brand book rendered: .brand/book.html (open in any browser).`

## /petals logo `[variant]`

When `/petals logo` is invoked, the agent hands out the logo *with its rules* — the asset alone invites redrawing.

1. **Guard**: if `.brand/` does not exist, report: `No brand configured. Run /petals init first.` and stop.
2. **Resolve the variant**:
   - default → `.brand/assets/logo.svg`
   - `mono` → the all-ink variant if present (`logo-mono.svg`); if absent, instruct: copy `logo.svg` and set every path fill to the brand ink color — the ONLY permitted recolor.
3. **Return** the asset path AND print the "Logo Usage" rules from `.brand/identity.md` (minimum size, clear space, exact fills, the never-list).
4. **When placing the logo in generated UI**: copy the asset file or inline its exact markup — never redraw, approximate, or restyle it. The color audit treats a logo with altered fills as an **error** (it is not a palette question; it is the mark).

## Guardrails (edit-time and merge-time)

The SKILL auto-trigger covers generation time. Two more lines of defense, both optional recipes a project can adopt:

**Edit-time — a deterministic hook.** The palette check is pure text matching; a Claude Code `PostToolUse` hook can run it on every edited UI file without an agent in the loop:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{ "type": "command", "command": "sh .claude/hooks/petals-hex-guard.sh" }]
    }]
  }
}
```

where `petals-hex-guard.sh` wraps the deterministic engine:

```sh
#!/bin/sh
# nudge, never block: report findings, exit 0
bash scripts/check.sh "$1" 2>/dev/null | grep -E 'ERROR|WARNING' || true
```

**Merge-time — CI.** A pull-request job runs the full five-dimension check on changed UI files:

```yaml
- name: brand check (deterministic — gates)
  run: |
    for f in $(git diff --name-only origin/main -- '*.tsx' '*.css' '*.html'); do
      bash scripts/check.sh "$f" || exit 1
    done
- name: brand check (agent — typography + tone, advisory)
  run: claude -p "/petals check $(git diff --name-only origin/main -- '*.tsx' '*.css' '*.html' | tr '\n' ' ')"
```

The deterministic engine is exact and gates the merge; the agent pass covers typography and tone and advises. No tokens are spent unless the cheap gate passes.

## .petalsrc Format

`.petalsrc` is a YAML file at the project root. It records the brand source, current version, and project-level overrides.

```yaml
# .petalsrc — Project brand configuration
brand:
  # The URL or path to the central brand repository
  source: github.com/company/brand

  # The version tag currently fetched (e.g., v1.2.0)
  version: v1.2.0

  # Project-level overrides. Non-null values are preserved during /petals update.
  # Null values inherit from the central brand on each update.
  # Keys are flattened dot-separated paths into .brand/ files.
  overrides:
    # Example: override the primary color for a campaign
    # colors.primary: "#FFD700"

    # Example: track but don't override the body font (inherits from central)
    # typography.body: null
```

### Override key conventions

Override keys use dot-separated paths that map to fields in `.brand/` markdown files:

| Key | Maps to | File |
|-----|---------|------|
| `colors.primary` | Primary hex value | `.brand/colors.md` |
| `colors.accent` | Accent hex value | `.brand/colors.md` |
| `typography.heading` | Heading font family | `.brand/typography.md` |
| `typography.body` | Body font family | `.brand/typography.md` |
| `typography.mono` | Mono font family | `.brand/typography.md` |
| `voice.terms` | Project-specific forbidden terms (appended as JSON array of {term, reason, use_instead} objects) | `.brand/voice.md` |

### Value semantics

- **Non-null string**: This value is preserved during updates. The central brand's value for this key is ignored.
- **null**: This key is tracked but not overridden. The central brand's value flows through on each update.
