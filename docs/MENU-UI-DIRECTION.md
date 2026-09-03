# Menu UI direction — for the next storefront polish pass

Recorded during Phase 04A.1. **Nothing in this document has been implemented.**
It exists so the direction is not lost between phases, and so the next pass
starts from a stated requirement rather than a fresh opinion.

## The problem

Entering Menu, a customer currently meets the `menu-hero` block first —
`pages/menu.html:38-42`, headed *"Everything coming out of the kitchen"* — and
the food sits below it. On a phone that hero costs most of the first screen, so
the thing the customer came for starts below the fold.

The second half is layout. `js/pages/menu.js:16` defaults `state.view` to
`"grid"` on every device, and `js/pages/menu.js:138` maps `list` to the
`row` food-card variant. So the horizontal card exists and is already built —
it is simply not what a phone gets by default.

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

## One thing I could not carry over

The instruction referenced screenshots in the originating conversation as the
intended visual direction. **No menu screenshots were present in it** — the
images captured during these phases were of the customer Live Chat, the admin
Orders board and the admin End-of-day screen. So the written requirements above
are recorded faithfully, but the visual reference is not, and whoever picks this
up should ask for the screenshots before starting rather than infer the
intended look from this file.
