---
version: alpha
name: Premium Default
description: Restrained, modern product UI. Linear/Vercel/Stripe aesthetic. Neutral surfaces, one accent, flat-with-borders.
colors:
  # Neutral surface ladder — carries 90% of the UI. Cool gray, never mixed with warm.
  bg:            "#FAFAFA"   # app canvas, lowest surface
  surface:       "#FFFFFF"   # cards, panels, raised containers
  surface-muted: "#F4F4F5"   # subtle fills, hover rows, code blocks, disabled
  border:        "#E4E4E7"   # 1px structural lines — the PRIMARY separator, not shadow
  border-strong: "#D4D4D8"   # input borders, dividers needing weight
  fg:            "#18181B"   # primary text & icons (near-black, never #000)
  fg-muted:      "#52525B"   # secondary text, descriptions
  fg-subtle:     "#A1A1AA"   # placeholder, metadata, disabled text
  # Accent — the ONLY interactive-element color. Buttons, links, focus rings,
  # active nav. NEVER used decoratively, in gradients, or on text blocks.
  accent:        "#4F46E5"
  accent-hover:  "#4338CA"
  on-accent:     "#FFFFFF"   # text/icons on accent fills
  accent-subtle: "#EEF2FF"   # accent-tinted bg for selected/active states only
  # Semantic — status communication ONLY, never decoration.
  success:       "#16A34A"
  warning:       "#D97706"
  destructive:   "#DC2626"
  on-destructive:"#FFFFFF"
typography:
  # One scale, ~1.25 ratio. Hierarchy via weight+color, not size explosions.
  display:   { fontFamily: Geist, fontSize: 48px, fontWeight: 600, lineHeight: 1.1,  letterSpacing: -0.02em }
  h1:        { fontFamily: Geist, fontSize: 32px, fontWeight: 600, lineHeight: 1.2,  letterSpacing: -0.02em }
  h2:        { fontFamily: Geist, fontSize: 24px, fontWeight: 600, lineHeight: 1.25, letterSpacing: -0.01em }
  h3:        { fontFamily: Geist, fontSize: 20px, fontWeight: 500, lineHeight: 1.3 }
  body:      { fontFamily: Geist, fontSize: 16px, fontWeight: 400, lineHeight: 1.6 }  # max 65ch
  body-sm:   { fontFamily: Geist, fontSize: 14px, fontWeight: 400, lineHeight: 1.5 }
  label:     { fontFamily: Geist, fontSize: 13px, fontWeight: 500, lineHeight: 1.4 }
  mono:      { fontFamily: "Geist Mono", fontSize: 13px, fontWeight: 400, lineHeight: 1.5 }  # code, IDs, numbers
rounded:
  sm:   6px      # inputs, badges, small controls
  md:   8px      # buttons
  lg:   12px     # cards, popovers, modals
  xl:   16px     # large feature containers
  full: 9999px   # avatars, pills, chips ONLY
spacing:        # 4px base, 8px rhythm. Every gap/pad snaps to a step. No off-scale values.
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
  3xl: 64px
components:
  button-primary:   { backgroundColor: "{colors.accent}", textColor: "{colors.on-accent}", typography: "{typography.label}", rounded: "{rounded.md}", height: 40px, padding: "0 16px" }
  button-secondary: { backgroundColor: "{colors.surface}", textColor: "{colors.fg}", rounded: "{rounded.md}", height: 40px, padding: "0 16px" }  # 1px {colors.border}
  button-ghost:     { backgroundColor: transparent, textColor: "{colors.fg-muted}", rounded: "{rounded.md}", height: 40px }
  input:            { backgroundColor: "{colors.surface}", textColor: "{colors.fg}", typography: "{typography.body-sm}", rounded: "{rounded.sm}", height: 40px, padding: "0 12px" }  # 1px {colors.border-strong}, focus ring {colors.accent}
  card:             { backgroundColor: "{colors.surface}", rounded: "{rounded.lg}", padding: "{spacing.lg}" }  # 1px {colors.border}, flat (no shadow) by default
  nav:              { backgroundColor: "{colors.surface}", textColor: "{colors.fg-muted}", height: 56px }  # active item = {colors.fg} text + {colors.accent-subtle} pill
  modal:            { backgroundColor: "{colors.surface}", rounded: "{rounded.lg}", padding: "{spacing.xl}" }  # elevation-2 shadow, backdrop rgba(0,0,0,0.4)
  table:            { backgroundColor: "{colors.surface}", textColor: "{colors.fg}", typography: "{typography.body-sm}" }  # header {colors.fg-muted}, row separators 1px {colors.border}, hover {colors.surface-muted}
  toast:            { backgroundColor: "{colors.fg}", textColor: "{colors.surface}", rounded: "{rounded.md}", padding: "{spacing.md}" }  # inverted; status uses semantic left-border
---

## Overview
Restrained, confident, content-first. Flat surfaces separated by 1px borders, not
shadows. Calm neutrals, a single accent that means "interactive." Density: balanced.
The feel is a precise tool (Linear/Vercel/Stripe), not a marketing landing page.

## Colors
Neutral surface ladder does the work; `accent` is the ONLY interaction color and is
used nowhere decorative. Semantic colors signal status only. Never pure #000/#fff for
large areas. Never mix warm and cool gray. One accent, saturation under ~80%.

## Typography
One scale, weight+color hierarchy. Body 16px / 1.6, capped at 65 characters per line.
Two weights carry everything (400 body, 500-600 headings). Mono for code, IDs, numbers.

## Layout
8px rhythm on a 4px base. Container max-width ~1200px, centered. CSS Grid over flex
math. Group by whitespace before reaching for borders. Generous padding inside cards
(24px). Single-column collapse below 768px; touch targets >= 44px.

## Elevation & Depth
Separation by 1px `border` first. Shadows: 2 levels max, soft and low-opacity
(rgba(0,0,0,0.05-0.10)), reserved for popovers/modals/toasts. No colored or glow shadows.

## Shapes
One radius family: inputs `sm`, buttons `md`, cards/modals `lg`. `full` only for
avatars/pills/chips. Never mix small-radius controls with large-radius cards.

## Components
Buttons flat, accent fill for primary, bordered surface for secondary, -1px translate
on active. Inputs: label above, error below, accent focus ring, no floating labels.
Cards flat + bordered. Loaders are skeletons matching layout, never spinners.

## Do's and Don'ts
DO: accent only for interaction; snap all spacing to scale; AA contrast (body >=4.5:1);
visible accent focus rings; placeholder labels like `[metric]` for unknown data.
DON'T: purple/neon gradients; gradient text on headings; emoji headers; center everything;
3-equal-card feature rows; mixed radii; glow shadows; fabricated stats or fake names
(Acme/John Doe); hype copy (Elevate/Seamless/Unleash); "scroll to explore" + chevrons;
the `Inter` default; pure black.
