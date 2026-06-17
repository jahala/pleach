# Brand Colors — {{BRAND_NAME}}

<!--
  Template: colors.md
  Every color value must be explicitly stated in source materials.
  DO NOT infer hex values from color names or visual samples.
-->

## Primary Palette

| Role | Hex | RGB | CMYK | OKLCH |
|------|-----|-----|------|-------|
| Primary | {{COLOR_PRIMARY_HEX}} | {{COLOR_PRIMARY_RGB}} | {{COLOR_PRIMARY_CMYK}} | {{COLOR_PRIMARY_OKLCH}} |
| Accent | {{COLOR_ACCENT_HEX}} | {{COLOR_ACCENT_RGB}} | {{COLOR_ACCENT_CMYK}} | {{COLOR_ACCENT_OKLCH}} |
| Background | {{COLOR_BG_HEX}} | {{COLOR_BG_RGB}} | {{COLOR_BG_CMYK}} | {{COLOR_BG_OKLCH}} |
| Text | {{COLOR_TEXT_HEX}} | {{COLOR_TEXT_RGB}} | {{COLOR_TEXT_CMYK}} | {{COLOR_TEXT_OKLCH}} |

## Semantic Roles

| Role | Hex | Usage |
|------|-----|-------|
| Error | {{COLOR_ERROR_HEX}} | {{COLOR_ERROR_USAGE}} |
| Success | {{COLOR_SUCCESS_HEX}} | {{COLOR_SUCCESS_USAGE}} |
| Warning | {{COLOR_WARNING_HEX}} | {{COLOR_WARNING_USAGE}} |
| Info | {{COLOR_INFO_HEX}} | {{COLOR_INFO_USAGE}} |

## Light / Dark Mode Variants

| Role | Light Mode | Dark Mode |
|------|-----------|-----------|
| Primary | {{PRIMARY_LIGHT}} | {{PRIMARY_DARK}} |
| Background | {{BG_LIGHT}} | {{BG_DARK}} |
| Text | {{TEXT_LIGHT}} | {{TEXT_DARK}} |
| Surface | {{SURFACE_LIGHT}} | {{SURFACE_DARK}} |
| Border | {{BORDER_LIGHT}} | {{BORDER_DARK}} |

## Usage Rules

- Primary color should occupy approximately {{PRIMARY_RATIO}} of the visible UI.
- Accent color is for {{ACCENT_USAGE}}.
- Never use error color for non-error states.
- Maintain WCAG AA contrast ratio (4.5:1) for body text, AAA (7:1) where possible.

## Approved Combinations

| Background | Foreground | Contrast Ratio | Use For |
|-----------|-----------|----------------|---------|
| {{BG_HEX_1}} | {{FG_HEX_1}} | {{RATIO_1}} | {{COMBO_USE_1}} |
| {{BG_HEX_2}} | {{FG_HEX_2}} | {{RATIO_2}} | {{COMBO_USE_2}} |

## Forbidden Combinations

- {{FORBIDDEN_COMBO_1}}
- {{FORBIDDEN_COMBO_2}}

## CSS Custom Properties

```css
:root {
  /* Primary palette */
  --color-primary: {{COLOR_PRIMARY_HEX}};
  --color-accent: {{COLOR_ACCENT_HEX}};
  --color-background: {{COLOR_BG_HEX}};
  --color-text: {{COLOR_TEXT_HEX}};

  /* Semantic */
  --color-error: {{COLOR_ERROR_HEX}};
  --color-success: {{COLOR_SUCCESS_HEX}};
  --color-warning: {{COLOR_WARNING_HEX}};
  --color-info: {{COLOR_INFO_HEX}};

  /* Dark mode */
  --color-primary-dark: {{PRIMARY_DARK}};
  --color-background-dark: {{BG_DARK}};
  --color-text-dark: {{TEXT_DARK}};
}
```
