# Menu UI direction — for the next storefront polish pass

Recorded during Phase 04A.1 and **implemented in Phase 04A.2**. Kept as the
record of why the Menu page is shaped the way it is, and of what the next
storefront pass should not undo.

## The problem (as it was)

Entering Menu, a customer met the `menu-hero` block first —
`pages/menu.html:38-42`, headed *"Everything coming out of the kitchen"* — with
the food below it. On a phone that hero cost most of the first screen, so the
thing the customer came for started below the fold.

The second half was layout. `js/pages/menu.js:16` defaulted `state.view` to
`"grid"` on every device, while `js/pages/menu.js:138` already mapped `list` to
the `row` food-card variant. The horizontal card was built and working — it
simply was not what a phone got by default.

## The requirements

1. **Food first.** The customer should reach actual products as quickly as
   possible on entering Menu. The introductory hero must not push the food far
   below the fold. Shrink it, collapse it on mobile, or move it — the
   constraint is where the food starts, not how the hero is styled.

2. **Horizontal/list is the DEFAULT on mobile.** Not a new layout — the
   existing `row` variant, promoted to the default at mobile widths. It is
   preferred because it:
   - shows the full product description,
   - shows price and category clearly,
   - uses less vertical space per item,
   - lets the customer see more food per scroll.

3. **Keep the grid.** The grid option stays exactly as it is and stays
   reachable from the existing `[data-view]` toggle. This is a change of
   default, not a removal of choice.

4. **Preserve the visual identity.** Spacing, typography, colours, the category
   rail, chips, filters, sort and the bottom navigation all stay as they are.

5. **Do not redesign unrelated pages.** This is the Menu page only.

## Scope note

This is a *default and density* change, not a redesign. The card variants, the
CSS and the toggle already exist; the work is choosing `row` for mobile,
reworking the hero's vertical cost, and checking both at 375 / 414 / 768 /
1440.

## On the visual reference

Screenshots in the originating conversation established the product direction.
They are not reachable from inside the coding context, so the implementation
did not attempt to recreate them. It used the **existing `row`/list card
component as the concrete source of truth** — which is what the screenshots
were showing anyway, since that component was already built and already close
to the intended result.

The screenshots settled four decisions, and only these: food should appear
sooner; horizontal/list should be the default; the Kandy's visual identity
stays; the interface should feel compact but not cramped. Everything else came
from the component that already existed.

## What Phase 04A.2 actually did

Measured at 375x667 before: hero 310px, sticky controls 269px, first product at
820px — 153px below the fold, so the page opened on no food at all.

After: hero 129px, controls 157px, first product at 520px with 81 of its 133px
visible above the bottom tab bar. Nothing was deleted — the lede still explains
per-scoop pricing and checkout-added packaging; it is sized like a caption
rather than a headline, the "The full menu" eyebrow (which repeated the
heading) is hidden on mobile, and the layout toggle moved beside the heading
instead of taking a 44px row of its own.

`state.view` now defaults to `"list"`. The toggle still switches both ways, and
`.menu__grid.is-list` is a responsive multi-column grid, so desktop gets a
denser list rather than one tall column. Desktop hero height is unchanged at
298px — every spacing rule is inside `@media (max-width: 719px)`.

Two consequences worth remembering:

- `css/responsive.css` had deliberately stacked search and sort at <=520px.
  That was reversed to a single row, which is where most of the control-height
  saving came from. If a future pass finds the search field too narrow at
  375px, that rule is the one to revisit.
- The row card renders no overlay tags on its photo, so the "Sold out" chip a
  grid card gets never appeared on it. That was harmless while grid was the
  default. It is not now, so the row card names the state on its meta line via
  `.fcard__soldout`. Do not remove that without restoring the chip.

### Still open

No view preference is persisted. There was none before this phase either —
`state.view` has always been in-memory — and the brief for 04A.2 said not to
build a preference system for it. A customer who prefers grid re-taps on each
visit, exactly as a customer who preferred list used to.
