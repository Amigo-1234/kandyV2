-- ============================================================================
-- Kandy's Treats V2 — 0003 Row Level Security
-- ----------------------------------------------------------------------------
-- The whole security model in one file, replacing firestore.rules.
--
-- Two layers are used deliberately, because RLS alone is not enough:
--
--   1. GRANTS decide which VERBS a role may attempt, and on which COLUMNS.
--      This is how "the browser can never write a wallet balance" is enforced:
--      `authenticated` is simply never granted INSERT or UPDATE on wallets.
--      No policy can be misread into allowing it, because the privilege to
--      try does not exist.
--
--   2. POLICIES decide which ROWS are visible or writable within the verbs
--      that were granted — almost always "the rows I own".
--
-- Supabase grants broad table privileges to anon/authenticated by default, so
-- every table below is revoked first and then granted back precisely.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Baseline: deny everything, then hand back exactly what is needed.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;

-- Future tables must not inherit Supabase's permissive defaults either.
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- Drop any existing policy on these tables so this migration can be re-run
-- during development without hand-unpicking it first.
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname
      from pg_policies
     where schemaname = 'public'
  loop
    execute format('drop policy if exists %I on %I.%I',
                   r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

alter table public.profiles            enable row level security;
alter table public.wallets             enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.categories          enable row level security;
alter table public.menu_items          enable row level security;
alter table public.coupons             enable row level security;
alter table public.announcements       enable row level security;
alter table public.app_settings        enable row level security;
alter table public.addresses           enable row level security;
alter table public.favourites          enable row level security;
alter table public.reviews             enable row level security;
alter table public.notifications       enable row level security;
alter table public.support_tickets     enable row level security;
alter table public.contact_messages    enable row level security;
alter table public.orders              enable row level security;
alter table public.order_items         enable row level security;
alter table public.order_status_history enable row level security;

-- ---------------------------------------------------------------------------
-- Public catalogue: readable by everyone, writable only by staff.
-- Guest browsing is a requirement, so `anon` gets SELECT.
-- ---------------------------------------------------------------------------

grant select on public.categories, public.menu_items, public.announcements,
                public.app_settings to anon, authenticated;

create policy categories_public_read on public.categories
  for select to anon, authenticated using (active);

create policy categories_admin_write on public.categories
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy menu_items_public_read on public.menu_items
  for select to anon, authenticated using (status <> 'hidden');

create policy menu_items_admin_write on public.menu_items
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy announcements_public_read on public.announcements
  for select to anon, authenticated
  using (
    active
    and (starts_at is null or starts_at <= now())
    and (ends_at   is null or ends_at   >= now())
  );

create policy announcements_admin_write on public.announcements
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy app_settings_public_read on public.app_settings
  for select to anon, authenticated using (true);

create policy app_settings_admin_write on public.app_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Coupons: only ACTIVE, UNEXPIRED ones are readable. They are already public
-- knowledge (the current build hardcodes them in js/lib/rules.js), and the
-- basket UI needs them to show "spend X more to qualify".
grant select on public.coupons to anon, authenticated;

create policy coupons_public_read on public.coupons
  for select to anon, authenticated
  using (active and (expires_at is null or expires_at > now()));

create policy coupons_admin_write on public.coupons
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- profiles — own row only; role changes blocked by trigger in 0001.
-- ---------------------------------------------------------------------------

grant select, insert, update on public.profiles to authenticated;

create policy profiles_select_own on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());

-- INSERT exists as a safety net only; the auth trigger normally creates this.
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (id = auth.uid());

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- wallets — READ ONLY for customers. No INSERT/UPDATE grant exists, so
-- "balance = 100000" from a browser is rejected before any policy is consulted.
-- Balance changes happen only inside the SECURITY DEFINER wallet RPCs (Phase 5).
-- ---------------------------------------------------------------------------

grant select on public.wallets to authenticated;

create policy wallets_select_own on public.wallets
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- wallet_transactions — append-only ledger, readable by its owner.
-- Again: no INSERT grant for customers, by design.
-- ---------------------------------------------------------------------------

grant select on public.wallet_transactions to authenticated;

create policy wallet_transactions_select_own on public.wallet_transactions
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- addresses — full CRUD, own rows only.
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on public.addresses to authenticated;

create policy addresses_select_own on public.addresses
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

create policy addresses_insert_own on public.addresses
  for insert to authenticated with check (user_id = auth.uid());

create policy addresses_update_own on public.addresses
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy addresses_delete_own on public.addresses
  for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- favourites — full CRUD, own rows only.
-- ---------------------------------------------------------------------------

grant select, insert, delete on public.favourites to authenticated;

create policy favourites_select_own on public.favourites
  for select to authenticated using (user_id = auth.uid());

create policy favourites_insert_own on public.favourites
  for insert to authenticated with check (user_id = auth.uid());

create policy favourites_delete_own on public.favourites
  for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- reviews — publicly readable (ratings appear on product pages), own writes.
-- ---------------------------------------------------------------------------

grant select on public.reviews to anon, authenticated;
grant insert, update, delete on public.reviews to authenticated;

create policy reviews_public_read on public.reviews
  for select to anon, authenticated using (true);

-- A customer may only review a dish they actually received: the referenced
-- order must be theirs, paid and Completed. This is the rule the current UI
-- applies in the browser; here it is enforced where it cannot be bypassed.
create policy reviews_insert_own on public.reviews
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1
        from public.orders o
       where o.id = reviews.order_id
         and o.user_id = auth.uid()
         and o.paid
         and o.status = 'Completed'
    )
  );

create policy reviews_update_own on public.reviews
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy reviews_delete_own on public.reviews
  for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- notifications — created by server-side triggers only. The customer may read
-- them and mark them read, and the COLUMN grant is what limits it to that:
-- they cannot rewrite a notification's title or message.
-- ---------------------------------------------------------------------------

grant select, delete on public.notifications to authenticated;
grant update (read, read_at) on public.notifications to authenticated;

create policy notifications_select_own on public.notifications
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

create policy notifications_update_own on public.notifications
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy notifications_delete_own on public.notifications
  for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- support_tickets — customer opens and reads their own; staff answer them.
-- Status is staff-controlled, so customers get no UPDATE grant on it.
-- ---------------------------------------------------------------------------

grant select, insert on public.support_tickets to authenticated;

create policy support_tickets_select_own on public.support_tickets
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

create policy support_tickets_insert_own on public.support_tickets
  for insert to authenticated with check (user_id = auth.uid());

create policy support_tickets_admin_update on public.support_tickets
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- contact_messages — the form works while signed out, so anon may INSERT.
-- Nobody but staff may read them back.
-- ---------------------------------------------------------------------------

grant insert on public.contact_messages to anon, authenticated;
grant select, update on public.contact_messages to authenticated;

create policy contact_messages_public_insert on public.contact_messages
  for insert to anon, authenticated with check (status = 'new');

create policy contact_messages_admin_read on public.contact_messages
  for select to authenticated using (public.is_admin());

create policy contact_messages_admin_update on public.contact_messages
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- orders — READ ONLY for customers.
--
-- This is the heart of the order-security requirement. `authenticated` is
-- granted SELECT and nothing else, so a browser cannot create an order at any
-- price, cannot mark one paid, and cannot move one to Completed. Orders are
-- created exclusively by the checkout RPC (Phase 5), which recomputes every
-- figure from menu_items inside the database.
-- ---------------------------------------------------------------------------

grant select on public.orders, public.order_items, public.order_status_history
  to authenticated;

create policy orders_select_own on public.orders
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

create policy orders_admin_write on public.orders
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy order_items_select_own on public.order_items
  for select to authenticated
  using (
    exists (
      select 1 from public.orders o
       where o.id = order_items.order_id
         and (o.user_id = auth.uid() or public.is_admin())
    )
  );

create policy order_items_admin_write on public.order_items
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy order_status_history_select_own on public.order_status_history
  for select to authenticated
  using (
    exists (
      select 1 from public.orders o
       where o.id = order_status_history.order_id
         and (o.user_id = auth.uid() or public.is_admin())
    )
  );

create policy order_status_history_admin_write on public.order_status_history
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Realtime. Supabase applies the same RLS policies to realtime payloads, so
-- these publications leak nothing a plain SELECT would not already return.
-- Replaces the three Firestore onSnapshot listeners.
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['orders', 'notifications', 'wallets'] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
