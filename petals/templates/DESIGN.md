# {{BRAND_DESIGN_SYSTEM}}

<!--
  Template: DESIGN.md — Google Stitch 9-section standard (Apache 2.0)
  Fill each section from extracted brand values.
  Placeholders `{{...}}` are replaced during extraction.
-->

## 1. Visual Theme & Atmosphere

{{VISUAL_THEME}}

**Primary Attributes:**
- {{VISUAL_ATTRIBUTE_1}}
- {{VISUAL_ATTRIBUTE_2}}
- {{VISUAL_ATTRIBUTE_3}}

## 2. Color Palette & Roles

| Role | Hex | Usage |
|------|-----|-------|
| Primary | {{COLOR_PRIMARY}} | {{COLOR_PRIMARY_USAGE}} |
| Accent | {{COLOR_ACCENT}} | {{COLOR_ACCENT_USAGE}} |
| Background | {{COLOR_BG}} | {{COLOR_BG_USAGE}} |
| Text | {{COLOR_TEXT}} | {{COLOR_TEXT_USAGE}} |
| Error | {{COLOR_ERROR}} | {{COLOR_ERROR_USAGE}} |
| Success | {{COLOR_SUCCESS}} | {{COLOR_SUCCESS_USAGE}} |

## 3. Typography Rules

| Level | Family | Weight | Size | Line Height | Letter Spacing |
|-------|--------|--------|------|-------------|----------------|
| h1 | {{FONT_HEADING}} | {{WEIGHT_H1}} | {{SIZE_H1}} | {{LINE_H1}} | {{TRACKING_H1}} |
| h2 | {{FONT_HEADING}} | {{WEIGHT_H2}} | {{SIZE_H2}} | {{LINE_H2}} | {{TRACKING_H2}} |
| body | {{FONT_BODY}} | {{WEIGHT_BODY}} | {{SIZE_BODY}} | {{LINE_BODY}} | {{TRACKING_BODY}} |
| caption | {{FONT_BODY}} | {{WEIGHT_CAPTION}} | {{SIZE_CAPTION}} | {{LINE_CAPTION}} | {{TRACKING_CAPTION}} |

## 4. Component Stylings

### Buttons
- **Primary:** {{BTN_PRIMARY_STYLE}}
- **Secondary:** {{BTN_SECONDARY_STYLE}}
- **States:** {{BTN_STATES}}

### Cards
- {{CARD_STYLE}}

### Inputs
- {{INPUT_STYLE}}

## 5. Layout Principles

- **Spacing Scale:** {{SPACING_SCALE}}
- **Grid:** {{GRID_SYSTEM}}
- **Max Width:** {{MAX_WIDTH}}
- **Whitespace Rhythm:** {{WHITESPACE_RHYTHM}}

## 6. Depth & Elevation

| Level | Shadow | Usage |
|-------|--------|-------|
| 0 | {{SHADOW_0}} | {{SHADOW_0_USAGE}} |
| 1 | {{SHADOW_1}} | {{SHADOW_1_USAGE}} |
| 2 | {{SHADOW_2}} | {{SHADOW_2_USAGE}} |
| 3 | {{SHADOW_3}} | {{SHADOW_3_USAGE}} |

## 7. Do's and Don'ts

### Do
- {{DO_1}}
- {{DO_2}}
- {{DO_3}}

### Don't
- {{DONT_1}}
- {{DONT_2}}
- {{DONT_3}}

## 8. Responsive Behavior

| Breakpoint | Min Width | Layout | Columns |
|------------|-----------|--------|---------|
| Mobile | {{BP_MOBILE}} | {{LAYOUT_MOBILE}} | {{COLS_MOBILE}} |
| Tablet | {{BP_TABLET}} | {{LAYOUT_TABLET}} | {{COLS_TABLET}} |
| Desktop | {{BP_DESKTOP}} | {{LAYOUT_DESKTOP}} | {{COLS_DESKTOP}} |
| Wide | {{BP_WIDE}} | {{LAYOUT_WIDE}} | {{COLS_WIDE}} |

## 9. Agent Prompt Guide

When generating UI or design output, follow these constraints:

1. **Colors:** Use only the palette defined in Section 2. Reference by semantic role, not raw hex.
2. **Typography:** Apply the hierarchy from Section 3. Never introduce fonts outside the defined families.
3. **Components:** Follow the styling rules in Section 4. Reuse patterns before inventing new ones.
4. **Spacing:** Adhere to the spacing scale in Section 5. Never use arbitrary pixel values.
5. **Elevation:** Apply shadow tokens from Section 6 by semantic level, not raw values.
6. **Responsive:** Start with mobile layout from Section 8, then enhance for larger breakpoints.
7. **Assets:** Source logos and images from .brand/assets/. Never invent placeholder logos.
8. **Voice:** Consult .brand/voice.md for copy. See .brand/colors.md for detailed color specs.
