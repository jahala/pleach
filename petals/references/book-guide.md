# Brand Book Guide

How `/petals book` renders `.brand/` as one self-contained HTML page. The
markdown files are for agents; the book is for the human who owns the brand —
a review surface, a shareable artifact, and (through its component exemplars)
a copy-source for agents.

## Contract

- **One file, no dependencies** beyond the brand's own font imports.
  `.brand/book.html` opens in any browser, offline, forever.
- **The book renders the RESOLVED product brand** — umbrella ⊕ the product
  layer. The masthead reads "<product> brand book · a <umbrella> brand";
  each section kicker names the owning layer (e.g. `colors.md · umbrella`,
  `products/petals/identity.md`). A flat brand renders exactly as before.
- **Every value rendered comes from a `.brand/` file** — the book is a view,
  never a second source of truth. Name the source file in each section's
  kicker (`colors.md`, `typography.md`, …).
- **The book passes `/petals check`**: palette-only hexes, exact font
  families, brand spacing and surface tokens, and the brand's own voice
  rules (casing, terminology, forbidden terms). Self-demonstration is the
  contract.
- **Flags float to the top.** Every `[FLAG: …]` in the brand files renders
  as a "needs an answer" card before any other section — the owner's review
  queue from extraction.

## Structure (one section per brand file)

| Section | Source | Renders |
|---------|--------|---------|
| Masthead | identity.md | Mark + name + tagline + brand version + generation date |
| Flags | all files | One card per `[FLAG: …]`, with the file and the question |
| Color | colors.md | Swatch cards (name, hex, role) for primary + semantic + terminal groups; the contrast-pairings table with ratio and class |
| Type | typography.md | A display-size specimen line; one row per level (heading / body / code) set in its own face |
| Layout | layout.md | The spacing scale as a ruler of true-size bars; container and breakpoints stated |
| Surface | components.md | Radius tiles at true radius; shadow cards carrying the real recipes; one hover element demonstrating the motion ease |
| Components | components.md | Canonical exemplars built purely from the tokens — buttons, a card, a terminal pane. View-source ready: an agent that copies these is on-brand by construction |
| Voice | voice.md | Trait chips; the forbidden-terms table (never → use instead); one before/after pair; the capitalization rules in one line |
| Logo | identity.md + assets/ | The mark on light and dark tiles; the usage rules as a list |
| Footer | — | "generated from .brand/" + the self-check badge |

## Rendering rules

- Use the brand's own tokens for the book's chrome (the book about the brand
  is set in the brand).
- True-size demonstrations beat descriptions: spacing bars are actually
  `4px…128px` wide; radius tiles actually carry the radius; shadows are the
  real recipes.
- Keep it calm: no animation beyond the one motion-demo hover; the book is
  for reading.
- Headings, labels, and chrome follow the brand's own casing and type rules — the book about the brand is set in the brand, chrome included. petals imposes no styling of its own.
