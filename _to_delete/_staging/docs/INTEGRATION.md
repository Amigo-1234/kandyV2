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

### Menu ids — action needed before go-live

V1 seeded with `addDoc()`, so every meal has a random Firestore id. V2 uses
readable slugs (`jollof-rice`) so deep links and the offline snapshot line up.
Run **`scripts/seed-menu.js`** once, signed in as an admin:

```js
await import('/scripts/seed-menu.js').then(m => m.seedMenu({ dryRun: true }))
await import('/scripts/seed-menu.js').then(m => m.seedMenu())
```

It writes the same menu with `setDoc()` + merge (preserving `status`,
`imageUrl` and admin edits) and **reports the old auto-id documents without
deleting them** — review, confirm the new ids work, then remove them.

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

## Still to do

1. **Run the seeder** so menu ids are slugs (above).
2. **Photograph the 17 items with no image** — listed in `NEEDS_PHOTO` in
   `js/data/images.js`, mostly drinks plus Big Fish. They render the branded
   placeholder until then.
3. **Wallet top-up UI** — `walletService.fund()` is wired; the account page
   currently shows balance and history and stubs the top-up button.
4. **Verify the deployed functions** accept this origin. `ALLOWED_WEB_ORIGINS`
   in `functions/index.js` must include wherever V2 is hosted.
5. **Favourites and reviews** — services exist (`accountService`), no UI yet.
6. Replace the footer's placeholder phone/email/address (`data-placeholder`).

## Verification

- Every page served and driven in Chromium at 1440 / 768 / 390 — **zero
  console errors, zero page errors, no horizontal overflow**.
- **32 source files** parse cleanly (`node --check`).
- **Pricing engine asserted against V1's server rules**: 7 basket cases
  (packaging tiers, pickup, drinks-only, coupon thresholds, wallet vs card)
  and 4 phone-normalisation cases — all pass.
- Menu integrity: 45 items, 7 categories, no duplicate ids, no zero prices,
  no orphaned categories.
- `npm run typecheck` and `npm run lint:functions` are wired but could not run
  in the build sandbox (npm registry blocked) — run them locally.
