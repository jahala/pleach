# Surface & Motion — {{BRAND_NAME}}

<!--
  Template: components.md
  Machine-readable surface & motion tokens — radius, borders, shadows,
  easings, durations, component conventions.
  Every value must be explicitly stated in source materials (design system
  docs, CSS, component libraries). DO NOT invent a scale the brand never
  defined — a missing token is flagged, not guessed.
-->

## Radius Scale

| Token | Value | Usage |
|-------|-------|-------|
| radius-xs | {{RADIUS_XS}} | {{RADIUS_XS_USAGE}} |
| radius-sm | {{RADIUS_SM}} | {{RADIUS_SM_USAGE}} |
| radius-md | {{RADIUS_MD}} | {{RADIUS_MD_USAGE}} |
| radius-lg | {{RADIUS_LG}} | {{RADIUS_LG_USAGE}} |
| radius-full | {{RADIUS_FULL}} | Pills, badges, dots |

## Border Strokes

| Token | Value | Usage |
|-------|-------|-------|
| stroke-hairline | {{STROKE_HAIRLINE}} | Structural borders, dividers |
| stroke-emphasis | {{STROKE_EMPHASIS}} | Emphasized borders, underlines |
| stroke-rule | {{STROKE_RULE}} | Accent rules, markers |

## Shadow Recipes

State the shadow color policy explicitly (e.g. ink-tinted vs neutral) and
the full value of each recipe.

| Token | Value | Usage |
|-------|-------|-------|
| shadow-rest | {{SHADOW_REST}} | Resting panes |
| shadow-lift | {{SHADOW_LIFT}} | Hover lift |
| shadow-float | {{SHADOW_FLOAT}} | Floating artifacts |

## Motion Tokens

| Token | Value | Usage |
|-------|-------|-------|
| ease | {{MOTION_EASE}} | Entrances and settles |
| dur-entrance | {{MOTION_DUR_ENTRANCE}} | Section / card entrances |
| dur-micro | {{MOTION_DUR_MICRO}} | Hovers, color shifts |
| stagger-step | {{MOTION_STAGGER}} | Sibling delay inside groups |

Rules:

- {{MOTION_PRINCIPLES}}
- `prefers-reduced-motion: reduce` MUST disable all entrances and staggers.
- Forbidden: {{MOTION_FORBIDDEN}}

## Component Conventions

| Component | Convention |
|-----------|------------|
| Button (primary) | {{COMPONENT_BUTTON_PRIMARY}} |
| Card | {{COMPONENT_CARD}} |
| Focus state | {{COMPONENT_FOCUS}} |

## Applying in frameworks

The brand wins over framework defaults. Mirror tokens as CSS custom
properties; extend Tailwind's theme (`borderRadius`, `boxShadow`,
`transitionTimingFunction`) instead of using stock utilities; override
component-library theme variables once at the theme layer.
