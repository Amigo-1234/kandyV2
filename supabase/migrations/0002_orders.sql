-- ============================================================================
-- Kandy's Treats V2 — 0002 orders, order lines, status history, wallet ledger
-- ----------------------------------------------------------------------------
-- Split from 0001 because these tables close the cycle with reviews, and
-- because this is the security-critical half of the schema.
--
-- Nothing in here is writable by a browser. Orders are created only by the
-- checkout RPC (Phase 5) and wallet rows only by the wallet RPCs, both
-- SECURITY DEFINER. 0002_rls.sql withholds the INSERT/UPDATE grants that
-- would otherwise let a customer write these directly.
-- ============================================================================

create table if not exists public.orders (
  id                  uuid primary key default gen_random_uuid(),
  -- human-facing reference shown to the customer, e.g. KD-2026-000123
  code                text not null unique,
  legacy_firestore_id text unique,
  user_id             uuid not null references public.profiles (id) on delete restrict,

  status              text not null default 'New'
                        check (status in ('New', 'Preparing', 'Out', 'Completed', 'Cancelled')),
  payment_status      text not null default 'pending'
                        check (payment_status in
                          ('pending', 'paid', 'failed', 'cancelled', 'refunded')),
  payment_provider    text,
  payment_ref         text,
  paid                boolean not null default false,

  fulfilment          text not null check (fulfilment in ('delivery', 'pickup')),
  -- kept as a reference for reporting, but the snapshot is what ships: an
  -- address edited or deleted later must not rewrite a historic order.
  address_id          uuid references public.addresses (id) on delete set null,
  address_snapshot    jsonb,
  customer            jsonb not null default '{}'::jsonb,
  notes               text not null default '',

  subtotal            integer not null check (subtotal >= 0),
  delivery_fee        integer not null default 0 check (delivery_fee >= 0),
  takeaway_fee        integer not null default 0 check (takeaway_fee >= 0),
  discount            integer not null default 0 check (discount >= 0),
  vat                 integer not null default 0 check (vat >= 0),
  processing_fee      integer not null default 0 check (processing_fee >= 0),
  total               integer not null check (total >= 0),
  coupon_code         text references public.coupons (code) on delete set null,

  estimated_minutes   integer,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- the totals must agree with each other at all times, whoever wrote them
  constraint orders_total_is_consistent check (
    total = subtotal + delivery_fee + takeaway_fee - discount + vat + processing_fee
  )
);

create index if not exists orders_user_idx   on public.orders (user_id, created_at desc);
create index if not exists orders_status_idx on public.orders (status, created_at desc);

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

create table if not exists public.order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders (id) on delete cascade,
  -- nullable: a dish may be retired from the menu long after it was ordered
  menu_item_id uuid references public.menu_items (id) on delete set null,
  -- name and unit_price are SNAPSHOTS. A later price change must never
  -- retroactively alter what a customer was charged.
  name         text    not null,
  unit_price   integer not null check (unit_price >= 0),
  qty          integer not null check (qty > 0),
  line_total   integer not null check (line_total >= 0),

  constraint order_items_line_total_is_consistent
    check (line_total = unit_price * qty)
);

create index if not exists order_items_order_idx on public.order_items (order_id);

-- Replaces the statusHistory array on the Firestore order document, so the
-- timeline is queryable and append-only rather than rewritten wholesale.
create table if not exists public.order_status_history (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders (id) on delete cascade,
  status     text not null,
  note       text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null
);

create index if not exists order_status_history_order_idx
  on public.order_status_history (order_id, created_at);

-- ---------------------------------------------------------------------------
-- Wallet ledger
-- ---------------------------------------------------------------------------

create table if not exists public.wallet_transactions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  type           text not null check (type in ('credit', 'debit')),
  reason         text not null
                   check (reason in ('funding', 'order_payment', 'refund', 'adjustment')),
  amount         integer not null check (amount > 0),
  -- the running balance after this entry, so history can be audited without
  -- replaying the whole ledger
  balance_after  integer not null check (balance_after >= 0),
  -- THE anti-double-credit guarantee. A gateway reference or an order id can
  -- only ever be banked once, no matter how many times a webhook retries.
  reference      text unique,
  order_id       uuid references public.orders (id) on delete set null,
  description    text not null default '',
  created_at     timestamptz not null default now()
);

create index if not exists wallet_transactions_user_idx
  on public.wallet_transactions (user_id, created_at desc);

-- Now that orders exists, close the reviews cycle.
alter table public.reviews
  drop constraint if exists reviews_order_id_fkey;
alter table public.reviews
  add constraint reviews_order_id_fkey
  foreign key (order_id) references public.orders (id) on delete set null;
