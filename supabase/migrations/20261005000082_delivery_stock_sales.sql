/* ==========================================================================
   Operations controls — Delivery switch, stock-based availability, sales series
   --------------------------------------------------------------------------
   Three additive pieces. No order, payment, wallet, pricing, referral or
   inventory-ledger row is changed, and create_checkout_order() is untouched:
   like enforce_ordering_enabled (0039), the new rules sit BESIDE checkout as
   triggers, so the pricing function and every payment path stay as they are.

   1. DELIVERY ON/OFF  (app_settings.delivery_enabled, manager tier)
      Default ON (current behaviour continues). When false, NO new delivery
      order is accepted — customer, stale browser, crafted request or staff
      alike; there is no exemption. Pickup is unaffected. Enforced by a
      BEFORE INSERT trigger on orders, so existing orders are never touched.

   2. STOCK-BASED AVAILABILITY  (app_settings.stock_availability_enabled)
      Inventory (0054) tracks finished, batch-cooked products — there are no
      ingredients or recipes in the schema — so "in stock" means the ledger's
      own equation, reused here rather than redefined:

        on hand = opening count + prepared + adjustments
                  - consumed (orders that reached the kitchen today)
                  - waste - staff meals
        remaining = on hand - portions held by New orders not yet cooked
                    (paid, or placed in the last 20 minutes)

      A tracked item with a KNOWN on-hand figure and fewer than one portion
      remaining is sold out automatically; recording a preparation or an
      adjustment brings it straight back. Unknown stock (no count baseline
      yet) is never treated as zero — the ledger's own rule — so such items
      follow their manual status only. Manual status always wins in the
      restrictive direction: a manager's "sold out" or "hidden" is never
      overridden by stock, and stock can only ever take an item OFF sale.

      Enforced at order time by an AFTER INSERT statement trigger on
      order_items (the whole checkout rolls back), and published to the
      storefront through menu_stock_out(), which returns item ids only —
      never quantities.

      Ships OFF. Applying this migration changes no menu item's availability:
      with the switch off, menu_stock_out() is empty and the order trigger
      does nothing. Management turns it on from App settings once the live
      inventory counts are trusted.

      The last portion cannot be sold twice: the order-time check takes a
      transaction-scoped advisory lock per tracked dish (in a fixed order, so
      two baskets cannot deadlock). A second checkout for the same dish waits
      for the first to commit, then sees its order in the held figure.

   3. SALES SERIES  admin_sales_series(grain, points) — read-only, manager+.
      Paid, non-refunded order value per Lagos day / week / month, the same
      definition of a legitimate sale the Finance screen already uses
      (paid, minus refunds — admin_refund_order sets payment_status
      'refunded' and leaves paid alone).
   ========================================================================== */

begin;

/* ---- Settings rows ------------------------------------------------------ */

insert into public.app_settings (key, value) values
  ('delivery_enabled',           'true'::jsonb),
  ('stock_availability_enabled', 'false'::jsonb)
on conflict (key) do nothing;

/* setting_tier (0039), setting_label (0074) and validate_app_setting (0039)
   reproduced line for line; the only additions are the two new keys. */
create or replace function public.setting_tier(p_key text)
returns text language sql immutable as $$
  select case p_key
           when 'ordering_enabled' then 'manager'
           when 'eta_minutes'      then 'manager'
           when 'delivery_enabled' then 'manager'
           when 'stock_availability_enabled' then 'manager'
           else 'owner'
         end;
$$;

create or replace function public.setting_label(p_key text)
returns text language sql immutable as $$
  select case p_key
           when 'ordering_enabled'    then 'Ordering'
           when 'eta_minutes'         then 'Estimated times'
           when 'delivery_fee'        then 'Delivery fee'
           when 'takeaway_fee'        then 'Takeaway packaging'
           when 'processing_fee_rate' then 'Processing fee rate'
           when 'service_area'        then 'Service area'
           when 'referral_referrer_points'    then 'Referral points — referrer'
           when 'referral_referred_points'    then 'Referral points — new customer'
           when 'referral_min_order'          then 'Minimum qualifying order'
           when 'referral_points_expiry_days' then 'Points expiry (days)'
           when 'reward_redemption_points'    then 'Points per redemption'
           when 'reward_redemption_naira'     then 'Naira per redemption'
           when 'delivery_enabled'            then 'Delivery'
           when 'stock_availability_enabled'  then 'Stock-based availability'
           else p_key
         end;
$$;

create or replace function public.validate_app_setting()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_tier text := public.setting_tier(new.key);
  v_v    jsonb := new.value;
begin
  /* Server-side callers (migrations, seeds) have no JWT and are trusted by
     virtue of their database role. */
  if auth.uid() is not null then
    if v_tier = 'owner' and not public.is_owner() then
      raise exception '% is an owner-only setting', public.setting_label(new.key)
        using errcode = '42501',
              hint = 'Fees and service area are the owner''s to change.';
    end if;
    if not public.is_manager() then
      raise exception 'Settings are available to admins and the owner only'
        using errcode = '42501';
    end if;
  end if;

  /* The key identifies the row; it is not editable. There is no column grant
     for it either, so this is the second lock on the same door. */
  if new.key is distinct from old.key then
    raise exception 'A setting cannot be renamed' using errcode = '42501';
  end if;

  /* Shape. Each branch asserts exactly what the reading code assumes. */
  if new.key = 'ordering_enabled' then
    if jsonb_typeof(v_v) <> 'boolean' then
      raise exception 'Ordering must be true or false' using errcode = '22023';
    end if;

  elsif new.key in ('delivery_enabled', 'stock_availability_enabled') then
    if jsonb_typeof(v_v) <> 'boolean' then
      raise exception '% must be true or false', public.setting_label(new.key)
        using errcode = '22023';
    end if;

  elsif new.key = 'delivery_fee' then
    if jsonb_typeof(v_v) <> 'number' or (v_v #>> '{}')::numeric < 0
       or (v_v #>> '{}')::numeric > 100000
       or (v_v #>> '{}')::numeric <> floor((v_v #>> '{}')::numeric) then
      raise exception 'Delivery fee must be a whole number of naira between 0 and 100,000'
        using errcode = '22023';
    end if;

  elsif new.key = 'processing_fee_rate' then
    if jsonb_typeof(v_v) <> 'number'
       or (v_v #>> '{}')::numeric < 0 or (v_v #>> '{}')::numeric > 0.2 then
      raise exception 'Processing fee rate must be between 0 and 0.2'
        using errcode = '22023';
    end if;

  elsif new.key = 'takeaway_fee' then
    if jsonb_typeof(v_v) <> 'object'
       or jsonb_typeof(v_v -> 'standard') <> 'number'
       or jsonb_typeof(v_v -> 'combined') <> 'number'
       or (v_v ->> 'standard')::numeric < 0 or (v_v ->> 'standard')::numeric > 100000
       or (v_v ->> 'combined')::numeric < 0 or (v_v ->> 'combined')::numeric > 100000 then
      raise exception 'Takeaway packaging needs a standard and a combined amount in naira'
        using errcode = '22023';
    end if;

  elsif new.key = 'eta_minutes' then
    if jsonb_typeof(v_v) <> 'object'
       or jsonb_typeof(v_v -> 'pickup') <> 'number'
       or jsonb_typeof(v_v -> 'delivery') <> 'number'
       or (v_v ->> 'pickup')::numeric < 1 or (v_v ->> 'pickup')::numeric > 240
       or (v_v ->> 'delivery')::numeric < 1 or (v_v ->> 'delivery')::numeric > 240 then
      raise exception 'Estimated times need a pickup and a delivery figure between 1 and 240 minutes'
        using errcode = '22023';
    end if;

  elsif new.key = 'service_area' then
    if jsonb_typeof(v_v) <> 'object'
       or btrim(coalesce(v_v ->> 'label', '')) = ''
       or btrim(coalesce(v_v ->> 'state', '')) = ''
       or btrim(coalesce(v_v ->> 'country', '')) = '' then
      raise exception 'Service area needs a label, a state and a country'
        using errcode = '22023';
    end if;
  end if;

  /* updated_at is in the column grant, so a client could otherwise backdate
     a change it had just made. */
  new.updated_at := now();
  return new;
end;
$$;

/* ---- 1. Delivery switch ------------------------------------------------- */

create or replace function public.enforce_delivery_enabled()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.fulfilment is distinct from 'delivery' then return new; end if;
  /* No exemptions: Delivery OFF refuses every new delivery order, whoever
     or whatever submits it — customer, stale browser, crafted request, or
     staff. Only inserts are seen, so existing orders are never touched. */

  if not coalesce(
       (select (value #>> '{}')::boolean
          from public.app_settings where key = 'delivery_enabled'), true) then
    raise exception 'Delivery is unavailable right now. Pickup is still open.'
      using errcode = '22023',
            hint = 'Delivery has been switched off from the admin settings.';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_delivery_enabled() from public, anon, authenticated;

drop trigger if exists orders_delivery_enabled on public.orders;
create trigger orders_delivery_enabled
  before insert on public.orders
  for each row execute function public.enforce_delivery_enabled();

/* ---- 2. Stock-based availability --------------------------------------- */

/*
   Remaining portions per tracked product, right now. Only products whose
   on-hand figure is KNOWN are returned (inventory active today and a count
   baseline exists); everything else is "unknown", never zero.
   p_exclude_order leaves one order's own lines out of the reservations, so
   a checkout is not blocked by itself.
*/
create or replace function public.kt_stock_remaining(p_exclude_order uuid default null)
returns table (menu_item_id uuid, remaining numeric)
language sql stable security definer set search_path = public as $$
  with bounds as (
    select public.kt_today_start() as v_from,
           public.kt_today_start() + interval '1 day' as v_to,
           (public.kt_today_start() at time zone 'Africa/Lagos')::date as v_date
  ),
  active as (
    select b.* from bounds b
     where exists (select 1 from public.app_settings s
                    where s.key = 'inventory_activated_on'
                      and (s.value #>> '{}')::date <= b.v_date)
  ),
  opening as (
    select distinct on (ic.menu_item_id) ic.menu_item_id, ic.qty
      from public.inventory_counts ic, active a
     where ic.business_date < a.v_date
     order by ic.menu_item_id, ic.business_date desc, ic.created_at desc
  ),
  moves as (
    select m.menu_item_id,
           coalesce(sum(m.qty) filter (where m.kind in ('prepared', 'adjustment')), 0)
         - coalesce(sum(m.qty) filter (where m.kind in ('waste', 'staff_meal')), 0) as net
      from public.inventory_movements m, active a
     where m.business_date = a.v_date
     group by m.menu_item_id
  ),
  used as (
    select c.menu_item_id, c.qty
      from active a, public.kt_inventory_consumption(a.v_from, a.v_to) c
  ),
  held as (
    select oi.menu_item_id, sum(oi.qty)::numeric as qty
      from public.orders o
      join public.order_items oi on oi.order_id = o.id
     where o.status = 'New'
       and (o.paid or o.created_at > now() - interval '20 minutes')
       and o.payment_status not in ('failed', 'cancelled', 'refunded')
       and o.id is distinct from p_exclude_order
     group by oi.menu_item_id
  )
  select mi.id,
         op.qty + coalesce(mv.net, 0) - coalesce(u.qty, 0) - coalesce(h.qty, 0)
    from public.menu_items mi
    join opening op on op.menu_item_id = mi.id
    left join moves mv on mv.menu_item_id = mi.id
    left join used  u  on u.menu_item_id  = mi.id
    left join held  h  on h.menu_item_id  = mi.id
   where mi.tracks_stock;
$$;
revoke all on function public.kt_stock_remaining(uuid) from public, anon, authenticated;

create or replace function public.kt_stock_rules_on()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::boolean from public.app_settings
                    where key = 'stock_availability_enabled'), false);
$$;
revoke all on function public.kt_stock_rules_on() from public, anon, authenticated;

/** Storefront read: ids of items stock has taken off sale. Ids only. */
create or replace function public.menu_stock_out()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.kt_stock_rules_on() then '[]'::jsonb
              else coalesce((select jsonb_agg(r.menu_item_id)
                               from public.kt_stock_remaining(null) r
                              where r.remaining < 1), '[]'::jsonb) end;
$$;
revoke all on function public.menu_stock_out() from public;
grant execute on function public.menu_stock_out() to anon, authenticated;

/* Order-time enforcement. One check per (order, product) over the whole
   statement, so two lines of the same dish (two takeaway packs) are summed.
   Raising aborts the checkout transaction: no order, no lines, no payment. */
create or replace function public.enforce_order_stock()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  r      record;
  v_item uuid;
begin
  if auth.uid() is null then return null; end if;
  if public.is_admin() then return null; end if;
  if not public.kt_stock_rules_on() then return null; end if;

  /*
     LAST-PORTION RACE. Two checkouts for the same dish run in separate
     transactions, and under READ COMMITTED neither can see the other's
     uncommitted order — both would see one portion left and both succeed.
     So the check is serialised per tracked dish with a transaction-scoped
     advisory lock: the second checkout waits here until the first commits
     (or rolls back), and its check below then runs on a fresh snapshot that
     includes the first order in the held figure. Locks are taken in a fixed
     (uuid) order so two baskets sharing dishes cannot deadlock, and only for
     stock-tracked dishes, so untracked dishes and pickups never wait. The
     lock ends with the transaction; it reserves nothing on its own.
  */
  for v_item in
    select distinct n.menu_item_id
      from new_rows n
      join public.menu_items mi on mi.id = n.menu_item_id and mi.tracks_stock
     order by n.menu_item_id
  loop
    perform pg_advisory_xact_lock(hashtextextended('kt_stock:' || v_item::text, 0));
  end loop;

  for r in
    select n.order_id, n.menu_item_id, min(n.name) as name, sum(n.qty)::numeric as qty
      from new_rows n
     group by n.order_id, n.menu_item_id
  loop
    perform 1 from public.kt_stock_remaining(r.order_id) s
     where s.menu_item_id = r.menu_item_id and s.remaining < r.qty;
    if found then
      if (select s.remaining from public.kt_stock_remaining(r.order_id) s
           where s.menu_item_id = r.menu_item_id) < 1 then
        raise exception 'Sorry — % is sold out right now.', r.name using errcode = '22023';
      end if;
      raise exception 'Only % portion(s) of % are left. Please reduce the quantity.',
        floor((select s.remaining from public.kt_stock_remaining(r.order_id) s
                where s.menu_item_id = r.menu_item_id)), r.name
        using errcode = '22023';
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function public.enforce_order_stock() from public, anon, authenticated;

drop trigger if exists order_items_stock on public.order_items;
create trigger order_items_stock
  after insert on public.order_items
  referencing new table as new_rows
  for each statement execute function public.enforce_order_stock();

/** Admin read: remaining portions for tracked items (manager menu badges). */
create or replace function public.admin_stock_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'enabled', public.kt_stock_rules_on(),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
                'menu_item_id', r.menu_item_id, 'remaining', r.remaining))
                from public.kt_stock_remaining(null) r), '[]'::jsonb));
end;
$$;
revoke all on function public.admin_stock_status() from public, anon;
grant execute on function public.admin_stock_status() to authenticated;

/* ---- 3. Sales series ---------------------------------------------------- */

create or replace function public.admin_sales_series(
  p_grain text default 'day', p_points integer default null
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_grain  text := case when p_grain in ('day', 'week', 'month') then p_grain else 'day' end;
  v_points integer := greatest(1, least(coalesce(p_points,
                        case v_grain when 'day' then 14 else 12 end), 60));
  v_step   interval := case v_grain when 'day' then interval '1 day'
                                    when 'week' then interval '1 week'
                                    else interval '1 month' end;
  v_last   timestamp := date_trunc(v_grain, now() at time zone 'Africa/Lagos');
  v_first  timestamp := v_last - v_step * (v_points - 1);
  v_prev   timestamp := v_first - v_step * v_points;
  v_rows   jsonb;
  v_cur    jsonb;
  v_before jsonb;
begin
  if not public.is_manager() then
    raise exception 'Finance is available to admins and the owner only'
      using errcode = '42501';
  end if;

  with sales as (
    select date_trunc(v_grain, o.created_at at time zone 'Africa/Lagos') as b, o.total
      from public.orders o
     where o.paid and o.payment_status <> 'refunded'
       and o.created_at >= (v_prev at time zone 'Africa/Lagos')
  ),
  buckets as (
    select generate_series(v_first, v_last, v_step) as b
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'start', to_char(k.b, 'YYYY-MM-DD'),
           'revenue', coalesce(s.revenue, 0),
           'orders',  coalesce(s.orders, 0)) order by k.b), '[]'::jsonb)
    into v_rows
    from buckets k
    left join (select b, sum(total)::bigint as revenue, count(*) as orders
                 from sales group by b) s on s.b = k.b;

  select jsonb_build_object('revenue', coalesce(sum(total), 0), 'orders', count(*))
    into v_cur from public.orders
   where paid and payment_status <> 'refunded'
     and created_at >= (v_first at time zone 'Africa/Lagos');
  select jsonb_build_object('revenue', coalesce(sum(total), 0), 'orders', count(*))
    into v_before from public.orders
   where paid and payment_status <> 'refunded'
     and created_at >= (v_prev  at time zone 'Africa/Lagos')
     and created_at <  (v_first at time zone 'Africa/Lagos');

  return jsonb_build_object(
    'grain', v_grain, 'points', v_points, 'generated_at', now(),
    'series', v_rows, 'current', v_cur, 'previous', v_before);
end;
$$;
revoke all on function public.admin_sales_series(text, integer) from public, anon;
grant execute on function public.admin_sales_series(text, integer) to authenticated;

commit;
