# Surface & Motion — plotplot

Machine-readable tokens for how surfaces are finished and how things move.
`DESIGN.md` §6–§9 carries the prose principles; this file carries the values
an agent (or `/petals check`) can verify against. Color values live in
`colors.md`; type and spacing live in `typography.md` and `layout.md`.

## Radius Scale

Corners come from a fixed scale. Anything else is off-brand.

| Token | Value | Usage |
|-------|-------|-------|
| radius-tail | 2px | The sharp "tail" corner on comment bubbles and pinned artifacts |
| radius-xs | 3px | Focus rings, tiny chips, inline code |
| radius-sm | 6px | Buttons, inputs, nav actions |
| radius-md | 8px | Terminal panes, ledgers, icon tiles, swatches |
| radius-lg | 10px | Cards, panels |
| radius-xl | 12px | Floating artifacts — specimen cards, comment bubbles |
| radius-full | 999px / 50% | Pills, badges, dots, pins |

## Border Strokes

| Token | Value | Usage |
|-------|-------|-------|
| stroke-hairline | 1px solid | Structural borders — cards, dividers, terminal frames |
| stroke-emphasis | 1.5px | Outline buttons, link underlines |
| stroke-rule | 2px | Accent rules — stat markers, point markers, dotted leaders |

Border color defaults to `#E2D8C0` on paper surfaces and `#403628` inside terminal panes (both from `colors.md`).

## Shadow Recipes

Shadows are always ink-tinted — `rgba(58, 39, 24, …)`, never pure black and never blue-gray. Two layers: a close contact shadow plus a soft ambient one.

| Token | Value | Usage |
|-------|-------|-------|
| shadow-rest | `0 1px 0 #E2D8C0, 0 12px 40px -16px rgba(58, 39, 24, 0.35)` | Hero terminal, large resting panes |
| shadow-lift | `0 2px 4px rgba(58, 39, 24, 0.05), 0 14px 32px rgba(58, 39, 24, 0.08)` | Cards on hover — the −3px lift |
| shadow-float | `0 2px 6px rgba(58, 39, 24, 0.07), 0 18px 44px rgba(58, 39, 24, 0.12)` | Floating artifacts — specimens, comment bubbles |

## Motion Tokens

One idea, used everywhere: **things unfold**. Elements rise and settle like leaves opening — never bounce, never pulse.

| Token | Value | Usage |
|-------|-------|-------|
| ease-petal | `cubic-bezier(0.22, 1, 0.36, 1)` | The only entrance/settle ease |
| dur-unfold | 0.8s | Section and card entrances (rise 30px + fade) |
| dur-micro | 0.15–0.3s | Hovers, color shifts, link underlines |
| stagger-step | 0.1s | Sibling delay inside a group — leaves along a stem |
| bloom | scale(0.6) rotate(−14°) → 1 / 0° over 0.55–0.7s | Marks, glyphs, pins — used once per element, on arrival |

Rules:

- Entrances use `ease-petal` + `dur-unfold`; micro-interactions use ease-out at `dur-micro`. No other easings.
- Groups stagger by `stagger-step`; nothing arrives as a slab.
- `prefers-reduced-motion: reduce` MUST disable all entrances, blooms, and staggers. Non-negotiable.
- Forbidden: bounce easings, pulsing/looping attention effects, parallax, confetti, spinners where progress is knowable.
- Playful character comes from the `bloom` arrival and the illustration — never from breaking the no-bounce rule.

## Component Conventions

| Component | Convention |
|-----------|------------|
| Button (primary) | Growth-green fill, cream text, radius-sm, weight 600; hover deepens to primary-deep, active translates down 1px |
| Button (sunlight) | Sunlight fill, ink text — high-momentum actions only (install, launch); radius-sm |
| Button (forest) | Forest fill, cream text — depth on paper, or the primary action inside a dark section |
| Button (outline) | Transparent fill, 1.5px primary border, primary text; hover fills with surface |
| Card | Surface background, stroke-hairline border, radius-lg; hover lifts −3px with shadow-lift |
| Terminal pane | Soil-night background + border from `colors.md`, radius-md, titlebar dots in error/caution/healthy order |
| Pill / badge | radius-full, surface background, mono text |
| Focus state | 2px solid primary outline, 3px offset, radius-xs — on every interactive element |

## Applying in frameworks

The brand wins over framework defaults (SKILL.md rule 5). In practice:

- **CSS** — mirror the tokens as custom properties (`--radius-sm: 6px`, `--ease-petal: …`) and reference them; never hard-code finishes inline.
- **Tailwind** — extend the theme rather than using stock utilities: `borderRadius` from the radius scale, `boxShadow` from the shadow recipes, `transitionTimingFunction.petal` from ease-petal. Stock `shadow-md`, `rounded-2xl`, `ease-bounce` are off-brand.
- **Component libraries (shadcn etc.)** — override the library's radius and shadow CSS variables at the theme layer once, instead of patching individual components.
