/* ==========================================================================
   0085 — Every menu product is in Inventory
   --------------------------------------------------------------------------
   THE PROBLEM

   Inventory listed only menu items with tracks_stock = true. 0054 switched
   that on for the seven batch-cooked dishes (sold per scoop or cup), and
   nothing switched it on for anything else, so proteins, drinks, sides,
   shawarma, soups, specials and chicken & chips never appeared — 79 of the
   86 live products on 2026-10-14.

   THE FIX

   Inventory scope no longer depends on tracks_stock. From the day this
   migration is applied, every menu product that is not in the trash is on
   the inventory board, under its existing id: created products appear
   automatically, renames show at once (nothing is copied), hidden or
   sold-out products are flagged, and trashed products leave the board while
   keeping their history.

   tracks_stock keeps exactly the two jobs it still has:
     - automatic stock-based menu availability (kt_stock_remaining), which
       stays OFF via stock_availability_enabled and is not switched here;
     - "prep-tracked": a batch-cooked dish is expected to have a preparation
       entry every day, so only those get the "Not entered" flag. A drink
       with no entry is normal.
   No menu_items row is updated by this migration.

   HISTORY IS NOT REWRITTEN

   Days before this migration keep their old scope (the dishes that were
   stock-tracked that day, per inventory_tracking_events), so every past
   board, variance and summary reads exactly as before. Nothing in
   inventory_movements or inventory_counts is updated or deleted.

   ALSO

   - Opening counts. A count can now be marked as an opening count — what is
     there before service. Today's opening is the latest opening count taken
     today, otherwise the last closing count carried from an earlier day.
     When both exist the difference is reported (overnight_change), so an
     opening count can never quietly hide a shortfall. Every existing count
     is a closing count (is_opening defaults to false; there are none in
     production today).
   - Staff may record counts (opening and closing). Every count is
     attributed and append-only, and a closing count can only reveal a
     variance, never hide one. Adjustments stay supervisor+.
   - Sales stay derived, never typed: consumption is the order lines of
     orders whose FIRST kitchen status (Preparing/Out/Completed) fell on that
     Lagos day — each order once, nothing written to the ledger, so a sale
     cannot be subtracted twice. admin_inventory_sales() lists the orders
     behind any day's "sold" figure so it can be reconciled.
   - kt_stock_remaining() uses the same opening rule, so availability (when
     it is one day switched on) agrees with the board. Still inert while
     stock_availability_enabled is false.

   Untouched: wallets, Paystack, Partner commissions, checkout, order
   creation, enforce_order_stock(), menu_stock_out(), the Ingredients
   register, End-of-Day reports (admin_day_reports() calls
   admin_inventory_day() and needs no change).
   ========================================================================== */

begin;

/* ---- 1. When "every product" began --------------------------------------- */

/* Same pattern as inventory_activated_on (0054): an operational date marker,
   written once, never by the client. Settings UI does not render unknown
   keys. */
insert into public.app_settings (key, value)
values ('inventory_all_products_on',
        to_jsonb((public.kt_today_start() at time zone 'Africa/Lagos')::date))
on conflict (key) do nothing;

/* ---- 2. Opening counts ------------------------------------------------------ */

alter table public.inventory_counts
  add column if not exists is_opening boolean not null default false;

comment on column public.inventory_counts.is_opening is
  'true: counted before service (that day''s opening). false: a closing '
  'count — the day''s counted figure, carried to the next day as its opening.';

/* ---- 3. Which products are in inventory on a day ------------------------- */

/*
   On or after inventory_all_products_on: every menu product that existed by
   the end of that day and was not in the trash at the end of it.
   Before it: the dishes that were stock-tracked at the end of that day, per
   inventory_tracking_events — exactly the scope 0084's history used.
   prep_tracked says whether the product was stock-tracked that day.
*/
create or replace function public.kt_inventory_scope(p_date date)
returns table (menu_item_id uuid, prep_tracked boolean)
language sql stable security definer set search_path = public as $$
  with b as (
    select ((p_date + 1)::timestamp at time zone 'Africa/Lagos') as hi,
           (select (s.value #>> '{}')::date from public.app_settings s
             where s.key = 'inventory_all_products_on') as all_on
  ),
  tracked as (
    select e.menu_item_id
      from b cross join lateral (
        select distinct on (te.menu_item_id) te.menu_item_id, te.tracked
          from public.inventory_tracking_events te
         where te.created_at < b.hi
         order by te.menu_item_id, te.created_at desc, te.id desc) e
     where e.tracked
  )
  select mi.id, (t.menu_item_id is not null)
    from public.menu_items mi
    cross join b
    left join tracked t on t.menu_item_id = mi.id
   where case when b.all_on is not null and p_date >= b.all_on
              then mi.created_at < b.hi and (mi.deleted_at is null or mi.deleted_at >= b.hi)
              else t.menu_item_id is not null end;
$$;
revoke all on function public.kt_inventory_scope(date) from public, anon, authenticated;

/* ---- 4. Consumption for every product -------------------------------------- */

/*
   Same definition as 0054 — portions on orders whose first kitchen status
   fell in [p_from, p_to) — without the "tracked only" filter. Each order is
   counted once however many history rows it has. Callers scope the result
   themselves: kt_stock_remaining() still joins tracks_stock.
*/
create or replace function public.kt_inventory_consumption(p_from timestamptz, p_to timestamptz)
returns table (menu_item_id uuid, qty numeric)
language sql stable security definer set search_path = public as $$
  with reached as (
    select h.order_id
      from public.order_status_history h
     where h.status in ('Preparing', 'Out', 'Completed')
     group by h.order_id
    having min(h.created_at) >= p_from and min(h.created_at) < p_to
  )
  select oi.menu_item_id, sum(oi.qty)::numeric
    from reached r
    join public.order_items oi on oi.order_id = r.order_id
    join public.menu_items mi on mi.id = oi.menu_item_id
   group by oi.menu_item_id;
$$;
revoke all on function public.kt_inventory_consumption(timestamptz, timestamptz)
  from public, anon, authenticated;

/* ---- 5. The daily picture ------------------------------------------------- */

/*
   Same equation as 0054:
     expected = opening + prepared + adjustments - sold - waste - staff meals
   NULL when the opening is unknown — never zero. What changed is scope
   (section 3), the opening rule (header), and that each row now says which
   category it is in, whether it is on the menu, and where its opening came
   from.
*/
create or replace function public.admin_inventory_day(p_day date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_from   timestamptz;
  v_to     timestamptz;
  v_date   date;
  v_active date;
  v_rows   jsonb;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  v_from := case when p_day is null then public.kt_today_start()
                 else (p_day::timestamp at time zone 'Africa/Lagos') end;
  v_to   := v_from + interval '1 day';
  v_date := (v_from at time zone 'Africa/Lagos')::date;

  select (value #>> '{}')::date into v_active
    from public.app_settings where key = 'inventory_activated_on';

  if v_active is null or v_date < v_active then
    return jsonb_build_object(
      'business_date', v_date, 'tracked', false,
      'activated_on', v_active,
      'reason', 'Inventory was not tracked on this date.',
      'items', '[]'::jsonb);
  end if;

  with scope as (
    select s.menu_item_id, s.prep_tracked from public.kt_inventory_scope(v_date) s
  ),
  moves as (
    select m.menu_item_id,
           sum(m.qty) filter (where m.kind = 'prepared')   as prepared,
           sum(m.qty) filter (where m.kind = 'waste')      as waste,
           sum(m.qty) filter (where m.kind = 'staff_meal') as staff_meal,
           sum(m.qty) filter (where m.kind = 'adjustment') as adjustment
      from public.inventory_movements m
     where m.business_date = v_date
     group by m.menu_item_id
  ),
  used as (
    select c.menu_item_id, c.qty from public.kt_inventory_consumption(v_from, v_to) c
  ),
  /* The latest opening count taken today. */
  op_today as (
    select distinct on (ic.menu_item_id) ic.menu_item_id, ic.qty, ic.created_at
      from public.inventory_counts ic
     where ic.business_date = v_date and ic.is_opening
     order by ic.menu_item_id, ic.created_at desc
  ),
  /* The latest count before today; it carries only if it was a closing
     count (a day that ended with only an opening count has no known close). */
  prior as (
    select distinct on (ic.menu_item_id) ic.menu_item_id, ic.qty, ic.business_date, ic.is_opening
      from public.inventory_counts ic
     where ic.business_date < v_date
     order by ic.menu_item_id, ic.business_date desc, (not ic.is_opening) desc, ic.created_at desc
  ),
  /* The latest closing count taken today. */
  closing as (
    select distinct on (ic.menu_item_id) ic.menu_item_id, ic.qty, ic.created_at
      from public.inventory_counts ic
     where ic.business_date = v_date and not ic.is_opening
     order by ic.menu_item_id, ic.created_at desc
  ),
  calc as (
    select mi.id, mi.name, mi.sale_unit, mi.category_id, mi.status,
           cat.name                     as category,
           cat.sort_order               as cat_sort,
           s.prep_tracked,
           case when pr.is_opening then null else pr.qty end as carried,
           case when pr.is_opening then null else pr.business_date end as carried_from,
           ot.qty                       as opening_count,
           ot.created_at                as opening_counted_at,
           coalesce(m.prepared, 0)      as prepared,
           coalesce(u.qty, 0)           as consumed,
           coalesce(m.waste, 0)         as waste,
           coalesce(m.staff_meal, 0)    as staff_meal,
           coalesce(m.adjustment, 0)    as adjustment,
           c.qty                        as counted,
           c.created_at                 as counted_at,
           (pr.menu_item_id is null and ot.menu_item_id is null and c.menu_item_id is null) as never_counted
      from scope s
      join public.menu_items mi on mi.id = s.menu_item_id
      left join public.categories cat on cat.id = mi.category_id
      left join moves    m  on m.menu_item_id  = s.menu_item_id
      left join used     u  on u.menu_item_id  = s.menu_item_id
      left join op_today ot on ot.menu_item_id = s.menu_item_id
      left join prior    pr on pr.menu_item_id = s.menu_item_id
      left join closing  c  on c.menu_item_id  = s.menu_item_id
  ),
  eq as (
    select calc.*,
           coalesce(opening_count, carried) as opening,
           case when opening_count is not null then v_date else carried_from end as opening_from,
           case when opening_count is not null then 'opening_count'
                when carried is not null then 'carried' end as opening_source,
           case when opening_count is not null and carried is not null
                then opening_count - carried end as overnight_change
      from calc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'menu_item_id', id,
           'name',         name,
           'sale_unit',    sale_unit,
           'category_id',  category_id,
           'category',     coalesce(category, category_id),
           'menu_status',  status,
           'prep_tracked', prep_tracked,
           'opening',      opening,
           'opening_from', opening_from,
           'opening_source', opening_source,
           'opening_counted_at', opening_counted_at,
           'carried',      carried,
           'overnight_change', overnight_change,
           'opening_established', opening is not null,
           'never_counted', never_counted,
           'prepared',     prepared,
           'consumed',     consumed,
           'waste',        waste,
           'staff_meal',   staff_meal,
           'adjustment',   adjustment,
           'net_change',   prepared + adjustment - consumed - waste - staff_meal,
           'expected_closing',
             case when opening is null then null
                  else opening + prepared + adjustment - consumed - waste - staff_meal end,
           'counted',      counted,
           'counted_at',   counted_at,
           'variance',
             case when opening is null or counted is null then null
                  else counted - (opening + prepared + adjustment - consumed - waste - staff_meal) end)
         order by cat_sort nulls last, category_id, name), '[]'::jsonb)
    into v_rows
    from eq;

  return jsonb_build_object(
    'business_date', v_date,
    'tracked',       true,
    'activated_on',  v_active,
    'all_products_on', (select (value #>> '{}')::date from public.app_settings
                         where key = 'inventory_all_products_on'),
    'from',          v_from,
    'to',            v_to,
    'generated_at',  now(),
    'viewer_role',   public.auth_role(),
    'can_adjust',    public.is_supervisor(),
    'items',         v_rows);
end;
$$;
revoke all on function public.admin_inventory_day(date) from public, anon;
grant execute on function public.admin_inventory_day(date) to authenticated;

/* ---- 6. Recording a movement ---------------------------------------------- */

/* Identical to 0054 except the product check: any menu product not in the
   trash, instead of stock-tracked products only. */
create or replace function public.inventory_record(
  p_menu_item_id uuid,
  p_kind         text,
  p_qty          numeric,
  p_reason       text default null,
  p_note         text default '',
  p_corrects_id  uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_date date;
  v_id   uuid;
  v_name text;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  if p_kind = 'adjustment' and not public.is_supervisor() then
    raise exception 'Adjustments are available to supervisors and above'
      using errcode = '42501';
  end if;

  if p_kind not in ('prepared', 'waste', 'staff_meal', 'adjustment') then
    raise exception 'Unknown movement kind: %', p_kind using errcode = '22023';
  end if;

  select name into v_name from public.menu_items
   where id = p_menu_item_id and deleted_at is null;
  if v_name is null then
    raise exception 'That product is not on the menu' using errcode = '22023';
  end if;

  v_date := (public.kt_today_start() at time zone 'Africa/Lagos')::date;

  if p_corrects_id is not null
     and not exists (select 1 from public.inventory_movements where id = p_corrects_id) then
    raise exception 'No such movement to correct' using errcode = 'P0002';
  end if;

  insert into public.inventory_movements
    (menu_item_id, business_date, kind, qty, reason, note, corrects_id, actor_id)
  values
    (p_menu_item_id, v_date, p_kind, p_qty,
     nullif(btrim(coalesce(p_reason, '')), ''), btrim(coalesce(p_note, '')),
     p_corrects_id, auth.uid())
  returning id into v_id;

  perform public.log_admin_action(
    'inventory.' || p_kind, 'inventory_movements', v_id::text,
    v_name || ': ' || p_kind || ' ' || p_qty ||
      coalesce(' (' || nullif(btrim(coalesce(p_reason, '')), '') || ')', '') ||
      case when p_corrects_id is not null then ' — correction' else '' end,
    jsonb_build_object('menu_item_id', p_menu_item_id, 'kind', p_kind,
                       'qty', p_qty, 'reason', p_reason,
                       'business_date', v_date, 'corrects_id', p_corrects_id));

  return jsonb_build_object('status', 'ok', 'id', v_id, 'business_date', v_date);
end;
$$;
revoke all on function public.inventory_record(uuid, text, numeric, text, text, uuid)
  from public, anon;
grant execute on function public.inventory_record(uuid, text, numeric, text, text, uuid)
  to authenticated;

/* ---- 7. Recording a count (opening or closing) ------------------------------ */

/* Replaces the 3-argument version; a call without p_opening still resolves
   here and records a closing count, as before. */
drop function if exists public.inventory_count_record(uuid, numeric, text);

create or replace function public.inventory_count_record(
  p_menu_item_id uuid,
  p_qty          numeric,
  p_note         text default '',
  p_opening      boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_date date;
  v_id   uuid;
  v_name text;
  v_open boolean := coalesce(p_opening, false);
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;
  if p_qty is null or p_qty < 0 then
    raise exception 'A count cannot be negative' using errcode = '22023';
  end if;

  select name into v_name from public.menu_items
   where id = p_menu_item_id and deleted_at is null;
  if v_name is null then
    raise exception 'That product is not on the menu' using errcode = '22023';
  end if;

  v_date := (public.kt_today_start() at time zone 'Africa/Lagos')::date;

  insert into public.inventory_counts (menu_item_id, business_date, qty, note, actor_id, is_opening)
  values (p_menu_item_id, v_date, p_qty, btrim(coalesce(p_note, '')), auth.uid(), v_open)
  returning id into v_id;

  perform public.log_admin_action(
    case when v_open then 'inventory.opening_count' else 'inventory.count' end,
    'inventory_counts', v_id::text,
    v_name || case when v_open then ': opening count ' else ': counted ' end || p_qty,
    jsonb_build_object('menu_item_id', p_menu_item_id, 'qty', p_qty,
                       'business_date', v_date, 'opening', v_open));

  return jsonb_build_object('status', 'ok', 'id', v_id, 'business_date', v_date,
                            'opening', v_open);
end;
$$;
revoke all on function public.inventory_count_record(uuid, numeric, text, boolean) from public, anon;
grant execute on function public.inventory_count_record(uuid, numeric, text, boolean) to authenticated;

/* ---- 8. A day's entries ------------------------------------------------------ */

/* As 0054; an opening count is listed with kind 'opening'. */
create or replace function public.admin_inventory_history(
  p_day date default null, p_menu_item_id uuid default null, p_limit integer default 100
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_date date;
  v_rows jsonb;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  v_date := case when p_day is null
                 then (public.kt_today_start() at time zone 'Africa/Lagos')::date
                 else p_day end;

  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb)
    into v_rows
    from (
      select m.id, m.kind, m.qty, m.reason, m.note, m.created_at,
             m.corrects_id, m.menu_item_id,
             mi.name as product,
             nullif(btrim(coalesce(p.display_name, '')), '') as actor,
             p.role as actor_role,
             'movement' as record
        from public.inventory_movements m
        join public.menu_items mi on mi.id = m.menu_item_id
        left join public.profiles p on p.id = m.actor_id
       where m.business_date = v_date
         and (p_menu_item_id is null or m.menu_item_id = p_menu_item_id)
      union all
      select c.id, case when c.is_opening then 'opening' else 'count' end, c.qty, null, c.note, c.created_at,
             null, c.menu_item_id,
             mi.name,
             nullif(btrim(coalesce(p.display_name, '')), ''),
             p.role, 'count'
        from public.inventory_counts c
        join public.menu_items mi on mi.id = c.menu_item_id
        left join public.profiles p on p.id = c.actor_id
       where c.business_date = v_date
         and (p_menu_item_id is null or c.menu_item_id = p_menu_item_id)
      order by created_at desc
      limit greatest(1, least(coalesce(p_limit, 100), 500))
    ) x;

  return jsonb_build_object('business_date', v_date, 'rows', v_rows);
end;
$$;
revoke all on function public.admin_inventory_history(date, uuid, integer) from public, anon;
grant execute on function public.admin_inventory_history(date, uuid, integer) to authenticated;

/* ---- 9. History over a date range ---------------------------------------- */

/*
   As 0084, with the scope of section 3 per day and the opening rule of the
   header. For days before inventory_all_products_on the scope, figures and
   flags are the ones 0084 produced. "Not entered" is only raised for
   prep-tracked dishes; "Not counted" for every product in scope.
*/
create or replace function public.admin_inventory_range(
  p_from date default null, p_to date default null, p_menu_item_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_today  date := (public.kt_today_start() at time zone 'Africa/Lagos')::date;
  v_from   date;
  v_to     date;
  v_active date;
  v_lo     timestamptz;
  v_hi     timestamptz;
  v_days   jsonb;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  v_to   := least(coalesce(p_to, v_today), v_today);
  v_from := coalesce(p_from, v_to - 6);
  if v_from > v_to then
    raise exception 'The start date must be on or before the end date' using errcode = '22023';
  end if;
  if v_to - v_from > 61 then
    raise exception 'Choose a range of 62 days or fewer' using errcode = '22023';
  end if;

  select (value #>> '{}')::date into v_active
    from public.app_settings where key = 'inventory_activated_on';

  v_lo := v_from::timestamp at time zone 'Africa/Lagos';
  v_hi := (v_to + 1)::timestamp at time zone 'Africa/Lagos';

  with days as (
    select g::date as d
      from generate_series(v_from, v_to, interval '1 day') g
  ),
  scope_on as (
    select dy.d, s.menu_item_id, s.prep_tracked
      from days dy
      cross join lateral public.kt_inventory_scope(dy.d) s
     where v_active is not null and dy.d >= v_active
  ),
  mv as (
    select m.business_date as d, m.menu_item_id,
           sum(m.qty) filter (where m.kind = 'prepared')   as prepared,
           sum(m.qty) filter (where m.kind = 'waste')      as waste,
           sum(m.qty) filter (where m.kind = 'staff_meal') as staff_meal,
           sum(m.qty) filter (where m.kind = 'adjustment') as adjustment,
           count(*) as entries
      from public.inventory_movements m
     where m.business_date between v_from and v_to
     group by 1, 2
  ),
  /* Latest closing count per day. */
  cnt as (
    select distinct on (c.business_date, c.menu_item_id)
           c.business_date as d, c.menu_item_id, c.qty, c.created_at,
           nullif(btrim(coalesce(p.display_name, '')), '') as actor
      from public.inventory_counts c
      left join public.profiles p on p.id = c.actor_id
     where c.business_date between v_from and v_to and not c.is_opening
     order by c.business_date, c.menu_item_id, c.created_at desc
  ),
  /* Latest opening count per day. */
  opc as (
    select distinct on (c.business_date, c.menu_item_id)
           c.business_date as d, c.menu_item_id, c.qty
      from public.inventory_counts c
     where c.business_date between v_from and v_to and c.is_opening
     order by c.business_date, c.menu_item_id, c.created_at desc
  ),
  reached as (
    select h.order_id, min(h.created_at) as t
      from public.order_status_history h
     where h.status in ('Preparing', 'Out', 'Completed')
     group by h.order_id
    having min(h.created_at) >= v_lo and min(h.created_at) < v_hi
  ),
  cons as (
    select (r.t at time zone 'Africa/Lagos')::date as d, oi.menu_item_id, sum(oi.qty)::numeric as qty
      from reached r
      join public.order_items oi on oi.order_id = r.order_id
     group by 1, 2
  ),
  keys as (
    select d, menu_item_id from scope_on
    union select d, menu_item_id from mv
    union select d, menu_item_id from cnt
    union select d, menu_item_id from opc
  ),
  scoped as (
    select k.d, k.menu_item_id
      from keys k
     where (p_menu_item_id is null or k.menu_item_id = p_menu_item_id)
       and v_active is not null and k.d >= v_active
  ),
  who as (
    select x.d, x.menu_item_id, jsonb_agg(distinct x.actor) filter (where x.actor is not null) as names
      from (
        select m.business_date as d, m.menu_item_id,
               nullif(btrim(coalesce(p.display_name, '')), '') as actor
          from public.inventory_movements m
          left join public.profiles p on p.id = m.actor_id
         where m.business_date between v_from and v_to
        union all
        select c.business_date, c.menu_item_id,
               nullif(btrim(coalesce(p.display_name, '')), '')
          from public.inventory_counts c
          left join public.profiles p on p.id = c.actor_id
         where c.business_date between v_from and v_to
      ) x
     group by 1, 2
  ),
  calc as (
    select s.d, s.menu_item_id, mi.name, mi.sale_unit, mi.category_id, mi.status,
           cat.name as category, cat.sort_order as cat_sort,
           (t.menu_item_id is not null) as tracked_that_day,
           coalesce(t.prep_tracked, false) as prep_tracked,
           case when pr.is_opening then null else pr.qty end as carried,
           case when pr.is_opening then null else pr.business_date end as carried_from,
           oc.qty as opening_count,
           coalesce(mv.prepared, 0)   as prepared,
           coalesce(cs.qty, 0)        as consumed,
           coalesce(mv.waste, 0)      as waste,
           coalesce(mv.staff_meal, 0) as staff_meal,
           coalesce(mv.adjustment, 0) as adjustment,
           coalesce(mv.entries, 0)    as entries,
           cn.qty as counted, cn.created_at as counted_at, cn.actor as counted_by,
           (pr.qty is null and oc.qty is null and cn.qty is null) as never_counted,
           coalesce(w.names, '[]'::jsonb) as recorded_by
      from scoped s
      join public.menu_items mi on mi.id = s.menu_item_id
      left join public.categories cat on cat.id = mi.category_id
      left join scope_on t on t.d = s.d and t.menu_item_id = s.menu_item_id
      left join mv  on mv.d = s.d and mv.menu_item_id = s.menu_item_id
      left join cnt cn on cn.d = s.d and cn.menu_item_id = s.menu_item_id
      left join opc oc on oc.d = s.d and oc.menu_item_id = s.menu_item_id
      left join cons cs on cs.d = s.d and cs.menu_item_id = s.menu_item_id
      left join who w on w.d = s.d and w.menu_item_id = s.menu_item_id
      left join lateral (
        select ic.qty, ic.business_date, ic.is_opening
          from public.inventory_counts ic
         where ic.menu_item_id = s.menu_item_id and ic.business_date < s.d
         order by ic.business_date desc, (not ic.is_opening) desc, ic.created_at desc
         limit 1) pr on true
  ),
  eq as (
    select calc.*,
           coalesce(opening_count, carried) as opening,
           case when opening_count is not null then d else carried_from end as opening_from,
           case when opening_count is not null then 'opening_count'
                when carried is not null then 'carried' end as opening_source,
           case when opening_count is not null and carried is not null
                then opening_count - carried end as overnight_change
      from calc
  ),
  item_json as (
    select c.d,
           jsonb_agg(jsonb_build_object(
             'menu_item_id', c.menu_item_id, 'name', c.name, 'sale_unit', c.sale_unit,
             'category_id', c.category_id, 'category', coalesce(c.category, c.category_id),
             'menu_status', c.status,
             'tracked_that_day', c.tracked_that_day,
             'prep_tracked', c.prep_tracked,
             'opening', c.opening, 'opening_from', c.opening_from,
             'opening_source', c.opening_source, 'carried', c.carried,
             'overnight_change', c.overnight_change,
             'opening_established', c.opening is not null,
             'never_counted', c.never_counted,
             'prepared', c.prepared, 'consumed', c.consumed, 'waste', c.waste,
             'staff_meal', c.staff_meal, 'adjustment', c.adjustment,
             'net_change', c.prepared + c.adjustment - c.consumed - c.waste - c.staff_meal,
             'expected_closing', case when c.opening is null then null
               else c.opening + c.prepared + c.adjustment - c.consumed - c.waste - c.staff_meal end,
             'counted', c.counted, 'counted_at', c.counted_at, 'counted_by', c.counted_by,
             'variance', case when c.opening is null or c.counted is null then null
               else c.counted - (c.opening + c.prepared + c.adjustment - c.consumed - c.waste - c.staff_meal) end,
             'entries', c.entries,
             'missing_entry', c.tracked_that_day and c.prep_tracked and c.entries = 0,
             'missing_count', c.tracked_that_day and c.counted is null,
             'recorded_by', c.recorded_by)
             order by c.cat_sort nulls last, c.category_id, c.name) as items,
           count(*) as n_items,
           count(*) filter (where c.tracked_that_day and c.prep_tracked and c.entries = 0) as missing_entries,
           count(*) filter (where c.tracked_that_day and c.counted is null) as missing_counts,
           count(*) filter (where c.counted is not null) as counted,
           sum(c.entries) as entries
      from eq c
     group by c.d
  ),
  entries as (
    select e.d, jsonb_agg(jsonb_build_object(
             'id', e.id, 'record', e.record, 'kind', e.kind, 'qty', e.qty, 'reason', e.reason,
             'note', e.note, 'created_at', e.created_at, 'corrects_id', e.corrects_id,
             'menu_item_id', e.menu_item_id, 'product', e.product,
             'actor', e.actor, 'actor_role', e.actor_role)
             order by e.created_at desc) as rows,
           count(*) filter (where e.note <> '') as notes,
           jsonb_agg(distinct e.actor) filter (where e.actor is not null) as people
      from (
        select m.business_date as d, m.id, 'movement' as record, m.kind, m.qty, m.reason, m.note,
               m.created_at, m.corrects_id, m.menu_item_id, mi.name as product,
               nullif(btrim(coalesce(p.display_name, '')), '') as actor, p.role as actor_role
          from public.inventory_movements m
          join public.menu_items mi on mi.id = m.menu_item_id
          left join public.profiles p on p.id = m.actor_id
         where m.business_date between v_from and v_to
           and (p_menu_item_id is null or m.menu_item_id = p_menu_item_id)
        union all
        select c.business_date, c.id, 'count',
               case when c.is_opening then 'opening' else 'count' end, c.qty, null, c.note,
               c.created_at, null, c.menu_item_id, mi.name,
               nullif(btrim(coalesce(p.display_name, '')), ''), p.role
          from public.inventory_counts c
          join public.menu_items mi on mi.id = c.menu_item_id
          left join public.profiles p on p.id = c.actor_id
         where c.business_date between v_from and v_to
           and (p_menu_item_id is null or c.menu_item_id = p_menu_item_id)
      ) e
     group by e.d
  )
  select coalesce(jsonb_agg(
           case when v_active is null or dy.d < v_active then
             jsonb_build_object('business_date', dy.d, 'tracked', false)
           else jsonb_build_object(
             'business_date', dy.d, 'tracked', true, 'is_today', dy.d = v_today,
             'items', coalesce(ij.items, '[]'::jsonb),
             'entries', coalesce(en.rows, '[]'::jsonb),
             'summary', jsonb_build_object(
               'items', coalesce(ij.n_items, 0),
               'entries', jsonb_array_length(coalesce(en.rows, '[]'::jsonb)),
               'missing_entries', coalesce(ij.missing_entries, 0),
               'missing_counts', coalesce(ij.missing_counts, 0),
               'counted', coalesce(ij.counted, 0),
               'notes', coalesce(en.notes, 0),
               'people', coalesce(en.people, '[]'::jsonb)))
           end order by dy.d desc), '[]'::jsonb)
    into v_days
    from days dy
    left join item_json ij on ij.d = dy.d
    left join entries en on en.d = dy.d;

  return jsonb_build_object(
    'from', v_from, 'to', v_to, 'today', v_today, 'activated_on', v_active,
    'all_products_on', (select (value #>> '{}')::date from public.app_settings
                         where key = 'inventory_all_products_on'),
    'viewer_role', public.auth_role(),
    'generated_at', now(),
    'days', v_days);
end;
$$;
revoke all on function public.admin_inventory_range(date, date, uuid) from public, anon;
grant execute on function public.admin_inventory_range(date, date, uuid) to authenticated;

/* ---- 10. The orders behind "sold" ----------------------------------------- */

/*
   Read-only. Every order line that makes up a product's "sold" figure on a
   Lagos day: the orders whose first kitchen status fell on that day, once
   each. A cancelled or refunded order still appears if it reached the
   kitchen — the food was cooked — and its status says so. total always
   equals that day's consumed figure for the product.
*/
create or replace function public.admin_inventory_sales(p_day date default null, p_menu_item_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_date date;
  v_lo   timestamptz;
  v_hi   timestamptz;
  v_rows jsonb;
  v_name text;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;
  if p_menu_item_id is null then
    raise exception 'Choose a product' using errcode = '22023';
  end if;
  select name into v_name from public.menu_items where id = p_menu_item_id;
  if v_name is null then
    raise exception 'That product does not exist' using errcode = 'P0002';
  end if;

  v_date := coalesce(p_day, (public.kt_today_start() at time zone 'Africa/Lagos')::date);
  v_lo := v_date::timestamp at time zone 'Africa/Lagos';
  v_hi := (v_date + 1)::timestamp at time zone 'Africa/Lagos';

  with reached as (
    select h.order_id, min(h.created_at) as t
      from public.order_status_history h
     where h.status in ('Preparing', 'Out', 'Completed')
     group by h.order_id
    having min(h.created_at) >= v_lo and min(h.created_at) < v_hi
  ),
  lines as (
    select o.code, o.status, o.payment_status, o.fulfilment, r.t as kitchen_at,
           sum(oi.qty)::numeric as qty
      from reached r
      join public.orders o on o.id = r.order_id
      join public.order_items oi on oi.order_id = r.order_id and oi.menu_item_id = p_menu_item_id
     group by o.code, o.status, o.payment_status, o.fulfilment, r.t
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'code', code, 'status', status, 'payment_status', payment_status,
           'fulfilment', fulfilment, 'kitchen_at', kitchen_at, 'qty', qty)
           order by kitchen_at), '[]'::jsonb)
    into v_rows
    from lines;

  return jsonb_build_object(
    'business_date', v_date, 'menu_item_id', p_menu_item_id, 'name', v_name,
    'total', (select coalesce(sum((x ->> 'qty')::numeric), 0) from jsonb_array_elements(v_rows) x),
    'orders', v_rows);
end;
$$;
revoke all on function public.admin_inventory_sales(date, uuid) from public, anon;
grant execute on function public.admin_inventory_sales(date, uuid) to authenticated;

/* ---- 11. Remaining stock (availability) uses the same opening rule ---------- */

/* As 0082 except the opening: today's opening count if one was taken, else
   the last closing count carried from an earlier day. Still only for
   stock-tracked products, and still only consulted when
   stock_availability_enabled is on (it is off). */
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
  op_today as (
    select distinct on (ic.menu_item_id) ic.menu_item_id, ic.qty
      from public.inventory_counts ic, active a
     where ic.business_date = a.v_date and ic.is_opening
     order by ic.menu_item_id, ic.created_at desc
  ),
  prior as (
    select distinct on (ic.menu_item_id) ic.menu_item_id, ic.qty, ic.is_opening
      from public.inventory_counts ic, active a
     where ic.business_date < a.v_date
     order by ic.menu_item_id, ic.business_date desc, (not ic.is_opening) desc, ic.created_at desc
  ),
  opening as (
    select coalesce(ot.menu_item_id, pr.menu_item_id) as menu_item_id,
           coalesce(ot.qty, case when pr.is_opening then null else pr.qty end) as qty
      from op_today ot
      full join prior pr on pr.menu_item_id = ot.menu_item_id
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
    join opening op on op.menu_item_id = mi.id and op.qty is not null
    left join moves mv on mv.menu_item_id = mi.id
    left join used  u  on u.menu_item_id  = mi.id
    left join held  h  on h.menu_item_id  = mi.id
   where mi.tracks_stock;
$$;
revoke all on function public.kt_stock_remaining(uuid) from public, anon, authenticated;

commit;
