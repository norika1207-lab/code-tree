// Design-taste layer. When the agent is asked to build or restyle a UI, prepend a concise design
// discipline so it produces premium, modern interfaces (Linear / Vercel / Stripe), not generic AI slop.
// Modeled on Google Labs' stitch-skills DESIGN.md approach: semantic tokens + hard "do/don't" rules.
// The full design system lives next to this file at ../design/DESIGN.md (the agent can read it).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESIGN_MD_PATH = path.resolve(__dirname, '..', 'design', 'DESIGN.md');

// Fire only on UI / frontend work — don't pollute backend / scripting tasks.
const UI_HINT = /\b(ui|ux|interface|frontend|front-end|web ?page|website|landing|dashboard|component|button|modal|form|layout|css|tailwind|styl(e|ing)|theme|design|react|vue|svelte|html|figma|navbar|sidebar|hero|card|responsive|app screen|mockup)\b/i;

export function isUiTask(text) {
  return UI_HINT.test(String(text || ''));
}

// Concise, opinionated discipline injected into the system prompt for UI tasks.
export const DESIGN_GUIDANCE = `(DESIGN DISCIPLINE — this task touches UI. Build it premium and modern, like Linear / Vercel / Stripe, not generic. These are hard constraints.)

A full design system with tokens is at src/design/DESIGN.md — read it and use its color / type / spacing / radius tokens. If it isn't present, follow this:

- COLOR: a neutral surface ladder carries ~90% of the UI; ONE accent is the only interactive-element color (buttons, links, focus rings, active nav) and appears nowhere decorative. Semantic colors (success/warning/destructive) for status only. Never pure #000/#fff for large areas; never mix warm and cool gray; accent saturation under ~80%.
- TYPE: one scale (12/14/16/20/24/32/48), ~1.25 ratio. Body 16px, line-height 1.6, capped ~65 chars/line. Hierarchy via WEIGHT + COLOR, not giant sizes. 2-3 weights max. Mono for code/IDs/numbers.
- SPACING: 4px base, 8px rhythm (4,8,12,16,24,32,48,64). Every margin/padding/gap snaps to the scale — no 13px, no 17px.
- RADIUS: one family (inputs 6, buttons 8, cards/modals 12). Never mix tiny-radius controls with big-radius cards. full radius only for avatars/pills/chips.
- ELEVATION: separate with a 1px border FIRST. Shadows: 2 levels max, soft and low-opacity (rgba(0,0,0,.05-.10)); reserve for popovers/modals. No colored or glow shadows.
- A11Y: WCAG AA (body >= 4.5:1), visible accent focus ring on every control, touch targets >= 44px, never color-only meaning.
- COMPONENT LIBS: React -> shadcn/ui (copy-in, you own the code) + Radix primitives (accessibility) + Radix Colors (neutral/accent scales). Non-React -> daisyUI. Dashboards/charts -> Tremor. Steal shadcn's "every surface token has a -foreground partner" convention and Material 3's role naming.

NEVER (these are the AI-slop tells that make UI look cheap): purple/indigo or neon gradients; gradient text on big headings; emoji as section headers; center-everything; the "3 equal cards in a row" feature grid; inconsistent radii; glassmorphism on everything; fabricated stats ("99.9% uptime", "10k+ users"); fake names (Acme / John Doe); hype copy (Elevate / Seamless / Unleash / Next-Gen); "scroll to explore" + bouncing chevrons; defaulting to the Inter font for a "premium" look (prefer Geist / Satoshi / Outfit). For unknown data use honest placeholders like [metric], not invented numbers.`;

// Curated open-source UI references, for tasks where the agent should pull real components.
export const UI_SOURCES = [
  { name: 'shadcn/ui', url: 'https://ui.shadcn.com', use: 'React/Tailwind copy-in components you own; bake DESIGN.md into its CSS vars' },
  { name: 'Radix Primitives', url: 'https://www.radix-ui.com/primitives', use: 'unstyled accessible behavior (focus, ARIA, keyboard)' },
  { name: 'Radix Colors', url: 'https://www.radix-ui.com/colors', use: 'best-engineered 12-step neutral + accent scales' },
  { name: 'Tailwind CSS', url: 'https://tailwindcss.com/docs/theme', use: 'token substrate; spacing/type/radius as CSS vars' },
  { name: 'Material Design 3', url: 'https://m3.material.io/styles/color/roles', use: 'rigorous color-role naming (surface-container, on-surface…)' },
  { name: 'daisyUI', url: 'https://daisyui.com', use: 'framework-agnostic CSS-only components + themes' },
  { name: 'Tremor', url: 'https://tremor.so', use: 'dashboards: charts, KPI cards, tables' },
  { name: 'Apple HIG', url: 'https://developer.apple.com/design/human-interface-guidelines', use: 'principles: clarity, deference, depth' },
];

// Return the guidance to prepend, or '' for non-UI tasks. Reads the live DESIGN.md tokens if present.
export function designGuidance(task) {
  if (!isUiTask(task)) return '';
  let tokens = '';
  try { tokens = fs.readFileSync(DESIGN_MD_PATH, 'utf8'); } catch {}
  return tokens
    ? `${DESIGN_GUIDANCE}\n\n--- the project's DESIGN.md (use these exact tokens) ---\n${tokens}`
    : DESIGN_GUIDANCE;
}
