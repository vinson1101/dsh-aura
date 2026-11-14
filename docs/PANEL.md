# The profile card's surface — what was tried, what was measured

The card keeps being described as "not glass". This file records what the
browser actually computed, so the next attempt starts from data instead of from
another token guess.

## Measured in this profile

Read through the pane's own diagnostic beacon (`card_style`), which reports the
computed background, the backdrop filter, how many `.aura-card` nodes exist, and
the stylesheets' rules that match the element.

| Attempt | Background set by the plugin | Computed result |
| --- | --- | --- |
| `var(--dsw-alias-bg-base)` (v0.17.x, restored in v0.19.2) | theme base | `rgb(13, 21, 36)` — **opaque** |
| `var(--dsw-alias-bg-overlay)` (v0.18.6) | overlay surface | `rgb(13, 21, 36)` — **opaque** |
| `rgba(22,24,30,.62)` + `color-mix(… 62%, transparent)` (v0.18.7) | translucent | reported as "no change" by eye |
| `color-mix(--aura-surface 26%, transparent)` + `blur(24px) saturate(190%)` (v0.19.0) | translucent | computed `rgb(13, 21, 36)`, `backdrop: none` |

Two facts worth keeping:

1. **The theme tokens that look like surfaces are opaque here.** `bg-base` and
   `bg-overlay` both resolve to `#0d1524`, so no token swap can produce glass.
2. **A translucent declaration computed back to an opaque colour with
   `backdrop: none`.** That means some other rule wins over the plugin's own
   declaration — not that the plugin's colour was wrong. The beacon's `winners`
   list (selector, colour, `!important`) is the way to name that rule; it was
   written but never read before the work was parked.

## Root cause (found in v0.19.8)

The `card_style` beacon reports the stylesheet rules that match the element and
set a background. It named this one:

```css
body[data-we-glass-page][data-we-floater-solid]
  :where([role="dialog"]):not([data-we-surface-runtime]):not(...)
  { background-color: var(--we-readability-base, #ffffff) !important }
```

A wallpaper glass plugin repaints **every `[role="dialog"]`** with an opaque
readability colour and `!important`. The card carried that role, so its own
translucent fill never applied. That is why six different colour attempts looked
identical: none of them reached the element.

The card is a popover inside a side pane, not a modal dialog. It now uses
`role="group"` with a descriptive label — which suits its behaviour — and the
forced repaint no longer matches.

**Lesson:** when a colour change has no visible effect, read the winning rule
before touching the colour. `getComputedStyle` alone shows the result, not the
source.

## What to do next time

1. Open the card once and read `card_style` from `$DSH_HOME/aura-diag.jsonl`.
2. `winners` names the rule that wins. If it belongs to the host or another
   plugin, do not fight it with `!important`; give the card a surface the
   winning rule does not target.
3. Only then choose a colour. The blur is a separate question from the fill: a
   `backdrop-filter` on an opaque element produces nothing at all.

## Parked, not abandoned

The look is frozen at the v0.19.2 rule — the first version's surface, with the
card moved clear of the chip that opens it. Everything else in the panel
(position, content, dismissal, voice preview, avatar) works and is tested.
