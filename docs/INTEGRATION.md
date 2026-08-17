# V1 → V2 integration notes

What was carried over from the V1 project, what was deliberately left behind,
and what still needs doing. **The V2 interface was not redesigned** — every
change below is data, business logic or copy behind the existing components.

---

## The decision: reuse V1's backend, don't rebuild it

V1's Cloud Functions are production-grade and already deployed to
`kandystreat-840b1` with secrets set. Rebuilding that would have thrown away
working, security-reviewed code for no gain. So V2 **adopts** it:
`functions/`, `firestore.rules`, `firestore.indexes.json`, `storage.rules`
and `firebase.json` now live in this repo and V2 is a new front end on the
same backend.

The property worth protecting: **clients cannot create or price orders.**
`createCheckoutOrder` re-reads every line from `menus/{id}`, verifies the
`addressId` belongs to the caller, recalculates fees and coupons, then writes
`orders` + `orderItems` with the Admin SDK. `firestore.rules` only lets a
browser create an order under the narrow `KD-PENDING-*` public-key fallback
shape. Payment is confirmed by `verifyGatewayPayment` plus idempotent signed
webhooks. Wallet movements are Firestore transactions.

## Business rules corrected to match V1

The Phase 1 UI shipped with invented numbers. All replaced, and
`js/lib/rules.js` now mirrors `functions/index.js` line for line.

| | Phase 1 (invented) | V1 (correct, now live) |
| --- | --- | --- |
| Delivery | ₦1,500, free over ₦20,000 | **flat ₦500**, no free tier |
| Service charge | 2.5% always | **2% processing fee, gateway only** — ₦0 on wallet |
| Packaging | none | **₦200**, or **₦300** with ofada, or rice + beans together |
| Coupons | none | **WELCOME5** 5% over ₦1,000 · **KANDY10** 10% over ₦5,000 |
| Fulfilment | delivery only | **delivery / pickup** |
| Statuses | 5 invented | **New → Preparing → Out → Completed** + `statusHistory` |
| Order id | `KT-24817` | **`KD-{ms}-{nnn}`** |
| Wallet | none | **full wallet** — balance, funding, refunds |

Seven pricing cases and four phone-normalisation cases are asserted against
these rules; see "Verification" below.

## The menu

Replaced wholesale with V1's real menu (`js/seedMenu.js`): **45 items across
Foods, Proteins, Sides, Specials, Soups, Shawarma, Drinks**, at real prices —
jollof **per scoop ₦500**, Big Chicken ₦2,500, Plantain ₦350, Beef Shawarma
₦2,800, Catfish Pepper Soup ₦3,500.

**One design tension, and how it was resolved.** Kandy's is a build-your-plate
kitchen: V1 has no add-on system, because proteins and sides *are* separate
menu items. The approved product page has an "Add a protein / Add a side /
Make it a meal" panel. Rather than delete a component you signed off, those
panels now list **real Proteins, Sides and Drinks items at their real prices**,
and every tick adds its own basket line with its own `menuId`. Same component,
faithful to V1's data model, and the server's re-pricing validates it exactly.
Pepper level became an order note, which V1 already supports (`notes`).

Invented per-item data (`rating`, `reviews`, `prep`, `serves`, `was`) was
removed rather than kept as decoration — the card metadata row now shows the
section and an honest "Cooked to order" style hint, and a rating only appears
if a real one exists. Filters and sorts were rebuilt on fields that actually
exist (quick picks, in-stock, price).

### Menu ids — resolved by the Supabase migration

This was a Firestore problem: V1 seeded with `addDoc()`, so every meal had a
random id. It no longer applies. The catalogue now lives in Supabase
`menu_items`, where each row carries its original Firestore id in
`legacy_firestore_id`, so old deep links and the bundled snapshot still
resolve. `scripts/seed-menu.js` was the Firestore seeder and has been deleted
along with the rest of the Firebase client code.

## Delivery area — Lagos State only, typed by hand

No GPS, no geocoding, no nationwide coverage. `KT.config.serviceArea` holds
the one place this is configured. Addresses are typed in full and saved to
`addresses/{id}` with V1's exact field set (`label`, `recipientName`, `phone`,
`address`, `notes`, `isDefault`), written through `saveCustomerAddress` with a
strict owner-only Firestore fallback for local development.

## Architecture

The approved UI is classic scripts on a global `KT` namespace. Rewriting it
all as ES modules to suit Firebase would have risked the design for no user
benefit, so the Firebase layer sits behind **one module entry** and publishes
itself:

```
js/config/app.js     project + commerce configuration      (classic)
js/lib/rules.js      pricing engine mirroring the server   (classic)
js/data/            menu snapshot + image manifest         (classic)
js/components/      approved UI, unchanged                 (classic)
js/pages/           per-page controllers                   (classic)
js/services/        Firebase: auth, menu, addresses,       (ES modules)
                    orders, payments, wallet, account
functions/          Cloud Functions (from V1)              (Node)
types/              JSDoc typedefs for `npm run typecheck`
scripts/            admin seeder
```

Pages react to three events: `kt:services`, `kt:auth`, `kt:menu`.

**Graceful degradation is deliberate.** If Firebase cannot load, the
storefront still renders from the bundled menu snapshot — and ordering is
*blocked*, never guessed at (`KT.menu.live` stays false and checkout refuses).

## Payments

Reuses V1's flow rather than inventing one: `createGatewayPayment` →
gateway-hosted page → `verifyGatewayPayment`, with webhooks as the safety net
and `payOrderWithWallet` for wallet payments. **No secret key appears in
client code.** Card details never touch this site.

> Note: V1 commits a **live Paystack public key** in
> `js/payment-public-config.js`. Public keys are safe to expose by design, but
> it is in git history — worth knowing. V2 does not ship the public-key
> fallback at all; it only uses the server-initialised flow.

## Live-data refresh

Every page paints from the bundled snapshot immediately, then repaints when
Firestore answers (`kt:menu`) and when auth settles (`kt:auth`). That matters:
without it a customer could see a snapshot price for an item the kitchen has
since repriced or sold out. `menuService.watch()` keeps an open subscription,
so a sold-out flip reaches an open tab without a reload, and
`KT.cart.reconcile()` drops basket lines that no longer exist.

## Announcements, notifications, support and reviews

Four V1 collections that had no V2 home now do — all through existing
components, no new design:

- **`announcements`** drives the promo strip. Whatever the kitchen publishes
  from V1's admin appears at the top of V2 within a page load; if nothing is
  published the strip keeps its standing delivery/coupon copy.
- **`notifications`** — V1's `sendOrderNotification` and
  `notifyOrderStatusChange` triggers already write these on every order and
  status change. They now surface as an "Updates" panel on the account page,
  with unread badges, tap-to-read, and mark-all-read. Order notifications link
  straight to the order.
- **`supportTickets`** — a "Need a hand?" panel on the account page, with the
  customer's orders in a dropdown so a ticket can be attached to one.
- **`contactMessages`** — the public intake path, no account needed.
- **`reviews/{uid_menuId}`** — rating stars appear on a **Completed** order,
  so a customer can only rate food they were actually delivered. Writing to
  the deterministic id means re-rating updates rather than duplicates. The
  product page shows the live average once a dish has ratings.

> **Bug found in V1.** V1's `contact.js` writes
> `{name, phone, message, createdAt, replied}`, but its own `firestore.rules`
> require exactly `["name","phone","message","status","source","createdAt"]`
> with `status == "new"`. V1's contact form is therefore rejected by its own
> security rules. `js/services/content.js` writes the shape the rules accept.
> Worth fixing in V1 too, or its contact page is silently dropping messages.

## Still to do

1. **Run the seeder** so menu ids are slugs (above). Until then checkout is
   deliberately blocked, because `KT.menu.live` never becomes true against
   auto-id documents.
2. **Photograph the 17 items with no image** — listed in `NEEDS_PHOTO` in
   `js/data/images.js`, mostly drinks plus Big Fish. They render the branded
   placeholder until then.
3. **Verify the deployed functions accept this origin.** `ALLOWED_WEB_ORIGINS`
   in `functions/index.js` must include wherever V2 is hosted. Local dev on
   `http://localhost:5501` is already listed.
4. **Rating aggregation.** Reviews are read per dish on the product page. If
   the menu ever needs averages on every card at once, add a `rating` field to
   `menus/{id}` maintained by a Cloud Function trigger on `reviews` — the card
   already renders `item.rating` when it exists, so nothing else changes.
5. **Admin surface** — V1's admin, super-admin, menu-builder, transactions and
   exports screens were NOT brought across; V2 is the customer storefront
   only. V1's admin keeps managing the same Firestore data unchanged.
6. Replace the footer's placeholder phone/email/address (`data-placeholder`).

### Completed since the first pass

- **Wallet top-up** — preset and custom amounts, gateway choice filtered by
  `getPaymentConfigurationStatus`, and the `?wallet=` return leg verified
  through `verifyWalletFundingPayment`.
- **Wallet activity** — real `transactions` history on the account page.
- **Favourites** — the product page heart writes `favourites/{uid_menuId}`,
  and saved items appear on the account page.
- **Offline banner** — one honest line when the backend cannot be reached.
- **Live repaints** — see above.
- **Announcements, notifications, support tickets, contact and reviews** —
  see the section above.

## Verification

- Every page served and driven in Chromium at 1440 / 768 / 390 — **zero
  console errors, zero page errors, no horizontal overflow**.
- **32 source files** parse cleanly (`node --check`).
- **Pricing engine asserted against V1's server rules**: 7 basket cases
  (packaging tiers, pickup, drinks-only, coupon thresholds, wallet vs card)
  and 4 phone-normalisation cases — all pass.
- Menu integrity: 45 items, 7 categories, no duplicate ids, no zero prices,
  no orphaned categories.
- Runtime contract asserted in-browser: `KT.config`, `KT.rules` and the full
  `KT.cart` API present; `KT.menu.live` false and the offline banner shown
  when the backend is unreachable.
- `npm run typecheck` and `npm run lint:functions` are wired but could not run
  in the build sandbox (the npm registry is blocked there) — run them locally.
- The sandbox also blocks the Firebase CDN, which means the browser sweep
  exercised the **offline path** end to end: the storefront renders from the
  snapshot, the offline banner appears, and ordering is disabled. That is the
  intended degraded behaviour, verified rather than assumed.
