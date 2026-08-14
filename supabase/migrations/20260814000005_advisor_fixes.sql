-- ============================================================================
-- Kandy's Treats V2 — 0005 hardening + performance, from the Supabase advisor
-- ----------------------------------------------------------------------------
-- The advisor returned 39 warnings and 0 errors against 0001-0004. This
-- migration clears all four categories. Nothing here changes WHO can see WHAT;
-- it changes how the same rules are evaluated.
--
--   1. Trigger functions had a mutable search_path.
--   2. Three functions were reachable as REST RPC endpoints.
--   3. Every policy re-evaluated auth.uid() once PER ROW.
--   4. Admin `for all` policies overlapped the read policies on SELECT.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Pin search_path on the two trigger functions that lacked it.
-- ---------------------------------------------------------------------------

alter function public.set_updated_at() set search_path = public;
alter function public.clear_other_default_addresses() set search_path = public;

-- ---------------------------------------------------------------------------
-- 2. Stop exposing internals through PostgREST.
--
-- handle_new_user() and protect_profile_role() are TRIGGER functions; the
-- trigger mechanism does not consult the caller's EXECUTE privilege, so
-- revoking it costs nothing and removes two /rest/v1/rpc/ endpoints.
--
-- is_admin() is different: RLS policy expressions are evaluated as the
-- querying role, so `authenticated` MUST retain EXECUTE or every admin policy
-- would fail with permission denied. `anon` never reaches a policy that calls
-- it, so only anon is revoked.
-- ---------------------------------------------------------------------------

revoke all on function public.handle_new_user()       from anon, authenticated;
revoke all on function public.protect_profile_role()  from anon, authenticated;
revoke all on function public.is_admin()              from anon;

-- ---------------------------------------------------------------------------
-- 3 + 4. Rebuild every policy.
--
-- `auth.uid()` becomes `(select auth.uid())`. Postgres then treats it as a
-- one-time InitPlan instead of a per-row call — the single highest-impact
-- change available on a Supabase schema, and it grows more important as the
-- orders table grows.
--
-- Admin policies are also split from `for all` into insert/update/delete, so
-- they no longer double up with the read policies on SELECT. Admin read access
-- is folded into the read policies themselves instead.
-- ---------------------------------------------------------------------------

do $$
declare r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies where schemaname = 'public'
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- ---- public catalogue -----------------------------------------------------
-- Staff additionally see rows hidden from customers, folded in here so there
-- is exactly one SELECT policy per table.

create policy categories_read on public.categories
  for select to anon, authenticated
  using (active or (select public.is_admin()));
create policy categories_admin_insert on public.categories
  for insert to authenticated with check ((select public.is_admin()));
create policy categories_admin_update on public.categories
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy categories_admin_delete on public.categories
  for delete to authenticated using ((select public.is_admin()));

create policy menu_items_read on public.menu_items
  for select to anon, authenticated
  using (status <> 'hidden' or (select public.is_admin()));
create policy menu_items_admin_insert on public.menu_items
  for insert to authenticated with check ((select public.is_admin()));
create policy menu_items_admin_update on public.menu_items
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy menu_items_admin_delete on public.menu_items
  for delete to authenticated using ((select public.is_admin()));

create policy announcements_read on public.announcements
  for select to anon, authenticated
  using (
    (select public.is_admin())
    or (active
        and (starts_at is null or starts_at <= now())
        and (ends_at   is null or ends_at   >= now()))
  );
create policy announcements_admin_insert on public.announcements
  for insert to authenticated with check ((select public.is_admin()));
create policy announcements_admin_update on public.announcements
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy announcements_admin_delete on public.announcements
  for delete to authenticated using ((select public.is_admin()));

create policy app_settings_read on public.app_settings
  for select to anon, authenticated using (true);
create policy app_settings_admin_insert on public.app_settings
  for insert to authenticated with check ((select public.is_admin()));
create policy app_settings_admin_update on public.app_settings
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy app_settings_admin_delete on public.app_settings
  for delete to authenticated using ((select public.is_admin()));

create policy coupons_read on public.coupons
  for select to anon, authenticated
  using (
    (select public.is_admin())
    or (active and (expires_at is null or expires_at > now()))
  );
create policy coupons_admin_insert on public.coupons
  for insert to authenticated with check ((select public.is_admin()));
create policy coupons_admin_update on public.coupons
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy coupons_admin_delete on public.coupons
  for delete to authenticated using ((select public.is_admin()));

-- ---- profiles -------------------------------------------------------------

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()))
  with check (id = (select auth.uid()) or (select public.is_admin()));

-- ---- wallet (read-only for customers; no write grant exists) --------------

create policy wallets_select_own on public.wallets
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

create policy wallet_transactions_select_own on public.wallet_transactions
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- ---- addresses ------------------------------------------------------------

create policy addresses_select_own on public.addresses
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy addresses_insert_own on public.addresses
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy addresses_update_own on public.addresses
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy addresses_delete_own on public.addresses
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---- favourites -----------------------------------------------------------

create policy favourites_select_own on public.favourites
  for select to authenticated using (user_id = (select auth.uid()));
create policy favourites_insert_own on public.favourites
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy favourites_delete_own on public.favourites
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---- reviews --------------------------------------------------------------
-- Insert still requires an order that is the caller's, paid, and Completed.

create policy reviews_read on public.reviews
  for select to anon, authenticated using (true);
create policy reviews_insert_own on public.reviews
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.orders o
       where o.id = reviews.order_id
         and o.user_id = (select auth.uid())
         and o.paid
         and o.status = 'Completed'
    )
  );
create policy reviews_update_own on public.reviews
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy reviews_delete_own on public.reviews
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---- notifications (UPDATE limited to read/read_at by column grant) -------

create policy notifications_select_own on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy notifications_update_own on public.notifications
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy notifications_delete_own on public.notifications
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---- support tickets ------------------------------------------------------

create policy support_tickets_select_own on public.support_tickets
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy support_tickets_insert_own on public.support_tickets
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy support_tickets_admin_update on public.support_tickets
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- ---- contact messages -----------------------------------------------------

create policy contact_messages_public_insert on public.contact_messages
  for insert to anon, authenticated with check (status = 'new');
create policy contact_messages_admin_select on public.contact_messages
  for select to authenticated using ((select public.is_admin()));
create policy contact_messages_admin_update on public.contact_messages
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- ---- orders (read-only for customers; no write grant exists) --------------

create policy orders_select_own on public.orders
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy orders_admin_insert on public.orders
  for insert to authenticated with check ((select public.is_admin()));
create policy orders_admin_update on public.orders
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy orders_admin_delete on public.orders
  for delete to authenticated using ((select public.is_admin()));

create policy order_items_select_own on public.order_items
  for select to authenticated
  using (
    exists (
      select 1 from public.orders o
       where o.id = order_items.order_id
         and (o.user_id = (select auth.uid()) or (select public.is_admin()))
    )
  );
create policy order_items_admin_insert on public.order_items
  for insert to authenticated with check ((select public.is_admin()));
create policy order_items_admin_update on public.order_items
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy order_items_admin_delete on public.order_items
  for delete to authenticated using ((select public.is_admin()));

create policy order_status_history_select_own on public.order_status_history
  for select to authenticated
  using (
    exists (
      select 1 from public.orders o
       where o.id = order_status_history.order_id
         and (o.user_id = (select auth.uid()) or (select public.is_admin()))
    )
  );
create policy order_status_history_admin_insert on public.order_status_history
  for insert to authenticated with check ((select public.is_admin()));
create policy order_status_history_admin_update on public.order_status_history
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy order_status_history_admin_delete on public.order_status_history
  for delete to authenticated using ((select public.is_admin()));
