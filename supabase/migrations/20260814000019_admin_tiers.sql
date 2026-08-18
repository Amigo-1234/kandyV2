-- ---------------------------------------------------------------------------
-- Admin tiers: staff -> admin -> owner
--
-- `owner` is the V2 equivalent of V1's `superAdmin`.
--
-- Design rule throughout: the UI is never the boundary. Every tier difference
-- below is enforced by a GRANT, an RLS policy, or a trigger, so a lower tier
-- is refused even when calling PostgREST or an RPC directly.
--
-- is_admin() is deliberately LEFT ALONE. It means "any admin tier"
-- (staff|admin|owner) and already backs ~50 policies; redefining it would
-- silently change all of them at once.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Tier helpers. SECURITY DEFINER so they bypass RLS on profiles and cannot
-- recurse into the policies that call them.
-- ---------------------------------------------------------------------------

create or replace function public.auth_role()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'anon');
$$;

create or replace function public.role_rank(p_role text)
returns integer language sql immutable as $$
  select case p_role
           when 'owner'    then 40
           when 'admin'    then 30
           when 'staff'    then 20
           when 'customer' then 10
           else 0
         end;
$$;

comment on function public.role_rank is
  'Ordered tier weight. Compare ranks rather than enumerating roles in policies.';

create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and role in ('admin', 'owner')
  );
$$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and role = 'owner'
  );
$$;

revoke all on function public.auth_role()        from public;
revoke all on function public.role_rank(text)    from public;
revoke all on function public.is_manager()       from public;
revoke all on function public.is_owner()         from public;
grant execute on function public.auth_role()     to authenticated, service_role;
grant execute on function public.role_rank(text) to authenticated, service_role;
grant execute on function public.is_manager()    to anon, authenticated, service_role;
grant execute on function public.is_owner()      to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Close the profiles INSERT privilege gap.
--
-- `role` was in the INSERT column grant and the policy only checked
-- id = auth.uid(). handle_new_user() normally pre-creates the row so the path
-- is unreachable — but if that trigger ever failed for a user, they could
-- insert their own profile with role='owner'. Removing the column grant means
-- the DEFAULT ('customer') always applies.
-- ---------------------------------------------------------------------------

revoke insert (role) on public.profiles from authenticated;

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated
  with check (id = (select auth.uid()) and role = 'customer');

-- ---------------------------------------------------------------------------
-- admin_audit_log — append-only from the client's point of view.
-- No INSERT/UPDATE/DELETE policy exists, so rows can only be written by
-- SECURITY DEFINER functions. Owners read everything; admins read their own.
-- ---------------------------------------------------------------------------

create table if not exists public.admin_audit_log (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid references public.profiles (id) on delete set null,
  actor_role   text        not null,
  action       text        not null,
  target_table text,
  target_id    text,
  summary      text        not null,
  detail       jsonb       not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists admin_audit_log_created_idx on public.admin_audit_log (created_at desc);
create index if not exists admin_audit_log_actor_idx   on public.admin_audit_log (actor_id);

alter table public.admin_audit_log enable row level security;

revoke all on public.admin_audit_log from anon, authenticated;
grant select on public.admin_audit_log to authenticated;

create policy admin_audit_log_read on public.admin_audit_log
  for select to authenticated
  using ((select public.is_owner()) or actor_id = (select auth.uid()));

/* Central writer. SECURITY DEFINER so callers need no table privilege. */
create or replace function public.log_admin_action(
  p_action text, p_target_table text, p_target_id text,
  p_summary text, p_detail jsonb default '{}'::jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.admin_audit_log
    (actor_id, actor_role, action, target_table, target_id, summary, detail)
  values
    (auth.uid(), public.auth_role(), p_action, p_target_table, p_target_id,
     p_summary, coalesce(p_detail, '{}'::jsonb));
end;
$$;

revoke all on function public.log_admin_action(text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.log_admin_action(text,text,text,text,jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- ORDERS — column-limited status updates.
--
-- The grant is the primary control: `status` and `updated_at` are the ONLY
-- columns any admin tier may write, so totals, paid, payment_status and
-- payment_ref are unreachable through PostgREST for every role. Settlement
-- stays the exclusive job of the service_role RPCs.
-- ---------------------------------------------------------------------------

grant update (status, updated_at) on public.orders to authenticated;

drop policy if exists orders_admin_update on public.orders;
create policy orders_admin_update on public.orders
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

/* Cancelling is a manager+ action; advancing the kitchen status is staff+.
   Both write the same column, so the tier split lives in a trigger. */
create or replace function public.enforce_order_status_tier()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status
     and new.status = 'Cancelled'
     and not public.is_manager() then
    raise exception 'Only an admin or owner may cancel an order'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_status_tier on public.orders;
create trigger orders_status_tier
  before update of status on public.orders
  for each row execute function public.enforce_order_status_tier();

/* Every admin status change is recorded in both the customer-visible timeline
   and the audit log, without needing an RPC. */
create or replace function public.audit_order_status_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status and auth.uid() is not null then
    insert into public.order_status_history (order_id, status, note, created_by)
    values (new.id, new.status, 'Updated by ' || public.auth_role() || '.', auth.uid());

    perform public.log_admin_action(
      'order.status_change', 'orders', new.code,
      'Order ' || new.code || ': ' || old.status || ' -> ' || new.status,
      jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return new;
end;
$$;

drop trigger if exists orders_status_audit on public.orders;
create trigger orders_status_audit
  after update of status on public.orders
  for each row execute function public.audit_order_status_change();

-- ---------------------------------------------------------------------------
-- CATALOGUE — staff may flip availability; only manager+ may change anything
-- else (prices above all); only owner may delete.
-- ---------------------------------------------------------------------------

grant update (name, blurb, description, price, category_id, section, status,
              image_key, image_url, tags, is_featured, is_quick_pick,
              sort_order, updated_at) on public.menu_items to authenticated;
grant insert on public.menu_items to authenticated;
grant delete on public.menu_items to authenticated;

create or replace function public.enforce_menu_item_tier()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_manager() then return new; end if;
  /* staff: availability only. Anything else is refused outright. */
  if new.price       is distinct from old.price
     or new.name        is distinct from old.name
     or new.category_id is distinct from old.category_id
     or new.blurb       is distinct from old.blurb
     or new.description is distinct from old.description
     or new.image_key   is distinct from old.image_key
     or new.image_url   is distinct from old.image_url
     or new.is_featured is distinct from old.is_featured
     or new.sort_order  is distinct from old.sort_order then
    raise exception 'Staff may only change item availability'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists menu_items_tier on public.menu_items;
create trigger menu_items_tier
  before update on public.menu_items
  for each row execute function public.enforce_menu_item_tier();

drop policy if exists menu_items_admin_insert on public.menu_items;
create policy menu_items_admin_insert on public.menu_items
  for insert to authenticated with check ((select public.is_manager()));

drop policy if exists menu_items_admin_delete on public.menu_items;
create policy menu_items_admin_delete on public.menu_items
  for delete to authenticated using ((select public.is_owner()));

-- categories / quick picks: manager writes, owner deletes
do $$
declare t text;
begin
  foreach t in array array['categories','quick_picks','quick_pick_items'] loop
    execute format('grant insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t||'_admin_insert', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select public.is_manager()))', t||'_admin_insert', t);
    execute format('drop policy if exists %I on public.%I', t||'_admin_update', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select public.is_manager())) with check ((select public.is_manager()))', t||'_admin_update', t);
    execute format('drop policy if exists %I on public.%I', t||'_admin_delete', t);
    execute format('create policy %I on public.%I for delete to authenticated using ((select public.is_owner()))', t||'_admin_delete', t);
  end loop;
end $$;

-- announcements / coupons: manager CRUD, owner delete
do $$
declare t text;
begin
  foreach t in array array['announcements','coupons'] loop
    execute format('grant insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t||'_admin_insert', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select public.is_manager()))', t||'_admin_insert', t);
    execute format('drop policy if exists %I on public.%I', t||'_admin_update', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select public.is_manager())) with check ((select public.is_manager()))', t||'_admin_update', t);
    execute format('drop policy if exists %I on public.%I', t||'_admin_delete', t);
    execute format('create policy %I on public.%I for delete to authenticated using ((select public.is_owner()))', t||'_admin_delete', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- APP SETTINGS — the store on/off switch is a daily operational act (staff+);
-- pricing and service area are owner-only.
-- ---------------------------------------------------------------------------

grant update (value, updated_at) on public.app_settings to authenticated;

drop policy if exists app_settings_admin_update on public.app_settings;
create policy app_settings_admin_update on public.app_settings
  for update to authenticated
  using  ((key = 'ordering_enabled' and (select public.is_admin())) or (select public.is_owner()))
  with check ((key = 'ordering_enabled' and (select public.is_admin())) or (select public.is_owner()));

drop policy if exists app_settings_admin_insert on public.app_settings;
create policy app_settings_admin_insert on public.app_settings
  for insert to authenticated with check ((select public.is_owner()));

drop policy if exists app_settings_admin_delete on public.app_settings;
create policy app_settings_admin_delete on public.app_settings
  for delete to authenticated using ((select public.is_owner()));

-- ---------------------------------------------------------------------------
-- Tighten reads to the approved matrix.
-- ---------------------------------------------------------------------------

-- money visibility: manager+, not staff
drop policy if exists wallets_select_own on public.wallets;
create policy wallets_select_own on public.wallets
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_manager()));

drop policy if exists wallet_transactions_select_own on public.wallet_transactions;
create policy wallet_transactions_select_own on public.wallet_transactions
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_manager()));

-- raw gateway payloads: owner only
drop policy if exists payment_events_admin_select on public.payment_events;
create policy payment_events_admin_select on public.payment_events
  for select to authenticated using ((select public.is_owner()));

-- contact messages: manager+
drop policy if exists contact_messages_admin_select on public.contact_messages;
create policy contact_messages_admin_select on public.contact_messages
  for select to authenticated using ((select public.is_manager()));

drop policy if exists contact_messages_admin_update on public.contact_messages;
create policy contact_messages_admin_update on public.contact_messages
  for update to authenticated
  using ((select public.is_manager())) with check ((select public.is_manager()));
grant update (status) on public.contact_messages to authenticated;

-- support tickets: staff+ may work them
grant update (status, updated_at) on public.support_tickets to authenticated;

-- editing someone else's profile is a manager+ act; self-edit unchanged
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) or (select public.is_manager()))
  with check (id = (select auth.uid()) or (select public.is_manager()));
grant update (display_name, phone, photo_url, updated_at) on public.profiles to authenticated;
