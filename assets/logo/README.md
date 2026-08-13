# Logo

The two SVGs in this folder are **placeholders**, not the Kandy's Treats logo.
They exist so nothing renders as a broken image while the real artwork is
being supplied.

## Swapping in the real logo

Overwrite these files, keeping the filenames:

| File | Used for | Rendered at |
| --- | --- | --- |
| `logo.png` | Header, mobile sheet, footer | 44–72 px |
| `kandys-treats-mark.svg` | Browser favicon | 16–64 px |

**Using a PNG instead?** Save it as `kandys-treats-logo.png`, then change the
two `src` values in:

- `js/components/navbar.js` → `logo()`
- `js/components/footer.js` → `foot__logo`

Those are the only two places in the entire project that reference the logo.

## Notes

- The header renders the logo at 52 px, shrinking to 44 px once the page
  scrolls, so supply artwork that stays legible small — the circular badge
  version works well.
- The footer sits on deep plum, so the logo is placed on a white circular
  chip there. A transparent-background file is ideal.
- Recommended: SVG. Failing that, a PNG at 3× (≥216 px square) with a
  transparent background.
