# Supabase backend — Kandy's Treats V2

Phase 1 of the Firebase → Supabase migration: **schema and RLS only**.

Nothing here is wired to the application yet. The site still runs entirely on
Firebase, which remains untouched as the fallback.

## Files

| File | What it does |
|---|---|
| `migrations/0001_schema.sql` | Helper functions, profiles, wallets, catalogue, customer-owned tables, the `auth.users` trigger |
| `migrations/0002_orders.sql` | Orders, order lines, status history, wallet ledger |
| `migrations/0003_rls.sql` | Grants + Row Level Security policies + realtime publication |
| `migrations/0004_seed_reference_data.sql` | Categories, coupons, pricing settings. No customer data, no menu items |

Run them **in numeric order**. Each is idempotent, so re-running is safe.

## Applying them

Create a project at supabase.com (region: **eu-west-1 / Ireland** is closest to
Lagos), then either:

**A — SQL editor.** Paste each file into the SQL editor in order and run it.
No tooling required. This is the quickest route.

**B — CLI.** Requires Docker.

```bash
npm i -g supabase && supabase link --project-ref <ref> && supabase db push
```

## The security model in one paragraph

Two layers, because RLS alone is not enough. **Grants** decide which verbs a
role may attempt and on which columns — `authenticated` is never granted
INSERT or UPDATE on `wallets`, `wallet_transactions`, `orders`, `order_items`
or `order_status_history`, so a browser cannot write a balance or an order
price at all; the privilege to try does not exist. **Policies** then restrict
the granted verbs to rows the caller owns. Writes to those tables happen only
inside `SECURITY DEFINER` functions added in Phase 5, which recompute every
figure from `menu_items` inside the database.

Two narrower cases worth knowing:

- `notifications` uses a **column-level** grant — `grant update (read, read_at)`
  — so a customer can mark one read but cannot rewrite its title or message.
- `reviews` inserts are gated on an `EXISTS` against `orders`: the referenced
  order must belong to the caller, be paid, and be `Completed`. The current
  build enforces that in the browser; here it cannot be bypassed.

## Verification status

The structure has been checked programmatically: referential ordering, RLS
enabled on all 17 tables, every policy and grant targeting a real table,
column-level grants naming real columns, no duplicate policy names, balanced
quoting.

**The SQL has not been executed.** There is no Postgres or Docker on the
machine it was written on, so the first real run will be on your Supabase
project. Expect to fix small things on first apply — run 0001 first and read
the output before continuing.

## What is deliberately NOT here

- **Menu items.** Copied from Firestore by the Phase 2 script (read-only
  against Firebase), so live prices are carried over rather than retyped.
- **The checkout and wallet RPCs.** Phase 5. Until they exist, no order can be
  created — which is correct: better no checkout than an untrusted one.
- **Payments.** Final phase, as agreed.
- **Storage buckets.** The V2 client makes zero Firebase Storage calls; photos
  are local files under `assets/`. Nothing to migrate unless the admin app
  starts uploading.
