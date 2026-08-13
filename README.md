# Kandy's Treats — V2

**Phase 1: customer-facing UI/UX only.**
No backend, no authentication, no database, no payments, no APIs. Every page
is HTML, CSS and vanilla JavaScript, structured so that Phase 2 can add real
functionality without rebuilding any of the interface.

---

## Running it

Any static server works. From the project root:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

or

```bash
npx serve .
```

Opening `index.html` directly from the filesystem also works — the project
uses classic scripts and a global `KT` namespace rather than ES modules,
specifically so `file://` doesn't break it.

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
├── pages/
│   ├── menu.html               Browse, search, filter, sort
│   ├── product.html            Product detail (?id=…)
│   ├── cart.html               Full basket + delivery + summary
│   ├── login.html
│   ├── signup.html
│   ├── account.html            Profile, addresses, cards, preferences
│   ├── orders.html             Order history
│   └── order-detail.html       Tracking timeline (?id=…)
├── css/
│   ├── global.css              Tokens, reset, type, buttons, forms
│   ├── navbar.css              Header, location pill, mobile sheet, tab bar
│   ├── hero.css
│   ├── categories.css
│   ├── cards.css               The food card system (3 variants)
│   ├── menu.css
│   ├── product.css             Quick-look modal, options, product page
│   ├── cart.css                Drawer + cart page
│   ├── promo.css
│   ├── discovery.css
│   ├── forms.css               Auth pages
│   ├── account.css             Account, orders, tracking
│   ├── footer.css
│   ├── animations.css          Keyframes, toasts, reduced-motion switch
│   └── responsive.css          All breakpoints, in one place
├── js/
│   ├── core/
│   │   ├── kt.js               Namespace, DOM helpers, icon set, formatting
│   │   ├── store.js            Cart state (presentation layer only)
│   │   └── reveal.js           Scroll entrance, parallax, rails
│   ├── data/
│   │   ├── menu.js             Mock menu — REPLACE WITH THE REAL MENU
│   │   ├── images.js           Image manifest — the only place photo URLs live
│   │   └── orders.js           Mock order history and profile
│   ├── components/
│   │   ├── navbar.js           Header + mobile sheet + bottom tab bar
│   │   ├── footer.js
│   │   ├── food-card.js        Card markup + add/stepper behaviour
│   │   ├── cart-drawer.js      Drawer + shared line/summary renderers
│   │   ├── product-modal.js    Quick look + shared option renderer
│   │   └── toast.js
│   ├── pages/                  One module per page
│   └── app.js                  Bootstrap: reads <body data-page>
└── assets/
    ├── logo/                   ← DROP THE REAL LOGO HERE (see below)
    ├── images/
    │   ├── food/               ← DROP REAL FOOD PHOTOS HERE
    │   └── brand/              Fallback placeholder
    └── icons/                  (icons are inline SVG in js/core/kt.js)
```

Shared chrome (header, footer, drawer, modal, toasts) is rendered by JS from
a single source, so no page duplicates it. Each page is `<div data-navbar>`,
its own content, `<div data-footer>`, and a `data-page` attribute that tells
`app.js` which module to run.

---

## Three things to replace

### 1. The logo — currently a marked placeholder

`assets/logo/kandys-treats-logo.svg` and `kandys-treats-mark.svg` are visibly
labelled placeholders, not a fake logo. Overwrite them with the real artwork,
keeping the filenames. See `assets/logo/README.md` for details — the logo is
referenced in exactly two places (`js/components/navbar.js` and
`js/components/footer.js`).

### 2. Food photography

Every image on the site resolves through `js/data/images.js`. **No HTML file
contains a photo URL.** The prototype serves curated stock photography from a
CDN; anything that fails to load falls back to a branded placeholder rather
than a broken-image icon.

To switch to the real photos:

1. Drop them into `assets/images/food/` using the filenames listed in the
   manifest (`party-jollof.jpg`, `meat-pie.jpg`, …).
2. Change one line in `js/data/images.js`:
   ```js
   var MODE = "local";   // was "remote"
   ```

Crop presets (`card`, `hero`, `detail`, `thumb`, …) are defined once in that
same file.

### 3. The menu

`js/data/menu.js` holds 42 placeholder items across six categories with
Naira pricing, add-on groups (pepper level, proteins, sides, drinks,
packaging), prep times, tags and ratings. Replace `CATEGORIES` and `ITEMS`
with the real menu — the shape is documented at the top of the file and
nothing else needs to change.

**Ratings and review counts are invented placeholder data.** The homepage and
menu page both say so on the page itself, so nobody mistakes them for real
numbers. Delete those notes when real ratings exist.

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
  modal with the full description and add-on options, so browsing isn't
  interrupted. It shares its option renderer with the product page.
- **Free-delivery progress.** The drawer and cart page show how much more is
  needed to cross the ₦20,000 threshold, with a progress bar.
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

## What is deliberately NOT here

Phase 1 stops at the visual layer. Everything below is out of scope and is
marked in the UI where a user would otherwise expect it to work:

- Supabase / Firebase / any database
- Authentication — the login and signup forms validate presentationally and
  submit nowhere
- Paystack, payment processing, verification, webhooks
- Real order submission — "Continue to checkout" says so explicitly
- Server-side APIs, admin dashboard

The cart uses `sessionStorage` purely so the basket survives page navigation
while clicking through the prototype. It is isolated behind the small
interface in `js/core/store.js`; swapping in a real backend means changing
that one file.

---

## Verified

Every page was served and checked in Chromium at 1440px, 768px and 390px:
zero console errors, zero page errors, no horizontal overflow, and the
add-to-cart, drawer, quick-look, sheet, filter and reorder flows were
exercised end to end.
