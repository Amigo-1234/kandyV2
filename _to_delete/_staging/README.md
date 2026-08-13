# Kandy's Treats — V2

The V2 customer storefront: the approved pink-and-white interface on top of
V1's proven Firebase backend.

- **Front end** — static HTML, CSS and vanilla JavaScript. No build step.
- **Back end** — Firebase Cloud Functions, Firestore and Storage, carried over
  from V1 (project `kandystreat-840b1`). Paystack and Flutterwave for payment.

Read **`docs/INTEGRATION.md`** first: it records what came across from V1,
the business rules that changed, and the two things still to do before
go-live.

---

## Running it

```bash
npm run dev          # serves on http://localhost:5501
```

Port 5501 matters: it is in `ALLOWED_WEB_ORIGINS` in `functions/index.js`, so
the Cloud Functions will accept calls from it.

`file://` will not work any more — the Firebase service layer is ES modules
and needs an origin. Without a server (or offline) the storefront still
renders from the bundled menu snapshot, but ordering is disabled by design.

### Checks

```bash
npm run typecheck        # tsc --checkJs over js/ using jsconfig.json
npm run lint:functions   # eslint over the Cloud Functions
npm run check            # both
```

### Deploying

```bash
npm run deploy:hosting   # front end
npm run deploy:backend   # functions + firestore rules/indexes + storage rules
```

Payment secrets are set once, server-side, and never appear in this codebase:

```bash
npm run secrets:paystack
npm run secrets:flutterwave
npm run secrets:flutterwave-hash
```

---

## The design system

**Colours.** White and a warm cream (`--surface-2`) carry the layout. Pink is
a tool, not a wallpaper — it is reserved for primary CTAs, active states,
price emphasis, brand marks and the ring motif. A deep plum
(`--kt-plum`) grounds the heavy sections (promo band, footer, toasts) so the
page has weight without ever going flat grey. Neutrals are warm-tinted, never
pure grey.

**Type.** Bricolage Grotesque for display (distinctive, slightly editorial,
not the usual template face), Plus Jakarta Sans for UI text. Both from Google
Fonts, with sensible system fallbacks.

**Two ownable devices**, both derived from the circular logo badge:

1. **The ring** — a circular photo crop inside a pink halo. Used for category
   tiles, cart thumbnails, order thumbnails, the hero plate, timeline dots.
2. **The ticket notch** — a scalloped/notched seam on the promo band,
   borrowed from bakery boxes and receipts. Used once per page, deliberately.

All tokens live at the top of `css/global.css`.

---

## Structure

```
/
├── index.html                  Homepage
├── pages/                      menu, product, cart, login, signup,
│                               account, orders, order-detail
├── css/                        design system + one file per surface
├── js/
│   ├── config/app.js           project, commerce and service-area config
│   ├── lib/rules.js            pricing engine mirroring functions/index.js
│   ├── core/                   namespace, basket, motion
│   ├── data/                   menu snapshot, image manifest
│   ├── components/             nav, cards, cart drawer, quick look, toast
│   ├── pages/                  one controller per page
│   ├── services/               Firebase (ES modules): auth, menu, addresses,
│   │                           orders, payments, wallet, account
│   └── app.js                  bootstrap
├── functions/                  Cloud Functions — server-side only
├── firestore.rules             owner-based access control
├── firestore.indexes.json
├── storage.rules
├── firebase.json / .firebaserc
├── scripts/seed-menu.js        admin: write the menu with stable slug ids
├── types/models.js             JSDoc typedefs for the type check
├── docs/INTEGRATION.md         what came from V1, and what is left
└── assets/
    ├── logo/                   the real Kandy's logo + favicons
    └── images/food/            real Kandy's photography, ported from V1
```

Shared chrome (header, footer, drawer, modal, toasts) is rendered by JS from
a single source, so no page duplicates it. Each page is `<div data-navbar>`,
its own content, `<div data-footer>`, and a `data-page` attribute that tells
`app.js` which module to run.

---


## Mobile

Mobile was designed as its own target, not derived from the desktop layout.
Below 768px the site switches to an app shell:

- **Bottom tab bar** — Home, Menu, Cart, Orders, Account, with a pink active
  pill and a live cart badge.
- **Sticky basket bar** — slides up above the tab bar as soon as the basket
  has something in it; shows count and running total.
- **Sheet navigation** — a full-height panel with the delivery address,
  primary links and a category grid, rather than a shrunken desktop navbar.
- **Bottom-sheet cart and product modal** — the drawer and quick-look become
  bottom sheets with a grab handle.
- **Horizontal category scrolling** with snap points; the trending rail does
  the same.
- **Row cards** for dense lists, switchable from the menu page's view toggle.

Breakpoints: 1200 / 1024 / 900 / 768 / 520 / 360, all in `css/responsive.css`.

---

## Interaction notes

- **Adding to the basket.** The circular pink button sits on the photo and
  morphs *in place* into a quantity stepper — nothing reflows. A small copy of
  the photo flies into the cart button, the badge bumps, and a toast offers to
  open the basket.
- **Quick look.** Hovering a card reveals a "Quick look" chip that opens a
  modal with the full description and upsell panels, so browsing isn't
  interrupted. It shares its option renderer with the product page.
- **Coupon progress.** Kandy's has no free-delivery tier, so the drawer's
  meter tracks the next real coupon threshold (WELCOME5 at ₦1,000, KANDY10 at
  ₦5,000) — the same component, honest content.
- **Scroll entrance.** Sections fade and rise once, staggered within a group.
- **Reduced motion.** `prefers-reduced-motion` switches off every animation,
  the parallax and the rotating hero word, in one block at the bottom of
  `css/animations.css`.

---

## Accessibility

Skip link, visible focus rings, `aria-current` on the active nav item,
`aria-pressed` on filter chips, labelled icon-only buttons, `aria-live` on
toasts and quantity values, Escape closes every overlay, and scroll locking
while an overlay is open. Colour pairings were chosen to stay legible against
the warm background rather than for pink saturation.

---


## Menu and photography

The menu is loaded live from Firestore `menus/{id}`; `js/data/menu.js` is a
snapshot for first paint and offline. Photos resolve through
`js/data/images.js` and nowhere else — real Kandy's photography ported from
V1, with a branded placeholder for the 17 items still awaiting a shot (listed
as `NEEDS_PHOTO` in that file).

## Verified

Every page served and driven in Chromium at 1440 / 768 / 390: zero console
errors, zero page errors, no horizontal overflow. All 32 source files parse
cleanly. The pricing engine is asserted against V1's server rules across
seven basket cases and four phone formats. See `docs/INTEGRATION.md`.
