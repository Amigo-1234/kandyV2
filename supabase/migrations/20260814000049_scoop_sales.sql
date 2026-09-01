/* ==========================================================================
   Scoop sales — the first component of the end-of-day business report
   --------------------------------------------------------------------------
   Kandy's sells rice and pasta by the scoop. Five products carry it today:
   Jollof, Fried, White and Ofada Rice at N700, and Sti-fried Spaghetti at
   N500. Until now the unit existed only inside the display name, as the
   suffix "(per scoop)" — so a daily total meant matching on a string, and
   renaming a product would have silently dropped it out of the count. The
   same category already carries a second convention, "(per cup)", which is
   how a naming convention usually ends.

   This migration does three things and deliberately nothing else:

     1. Makes the sale unit a property of the product rather than of its name.
     2. Snapshots that unit onto every order line, so history cannot be
        rewritten by a later catalogue edit.
     3. Adds ONE read-only, day-scoped RPC that reports scoops sold.

   WHAT THIS IS NOT
   ----------------
   Not an inventory system. Nothing here records stock, and the report is a
   read over order_items — there is no second place where a sale is written
   down, and therefore no second number that can disagree with the first.
   ========================================================================== */

begin;

/* ---- 1. The unit becomes a column -------------------------------------- */

/*
   A small closed vocabulary rather than free text: the point of this change
   is that a report can trust the value, and free text would put us back where
   we started. 'unit' is the default and means "an ordinary item" — a drink, a
   plate, a box. New units get added to the CHECK when a real product needs
   one, which is a deliberate act rather than a typo.
*/
alter table public.menu_items
  add column if not exists sale_unit text not null default 'unit'
    check (sale_unit in ('scoop', 'cup', 'unit'));

/*
   The order line carries its own copy. order_items already snapshots `name`
   and `unit_price` for exactly this reason — a price change must never
   retroactively alter what a customer was charged — and the same argument
   applies to the unit: menu_item_id is ON DELETE SET NULL, so retiring a
   product would otherwise orphan its history and quietly change last month's
   scoop total.
*/
alter table public.order_items
  add column if not exists sale_unit text not null default 'unit'
    check (sale_unit in ('scoop', 'cup', 'unit'));

comment on column public.menu_items.sale_unit is
  'How this product is sold. Drives scoop reporting. Manager+ may change it; '
  'enforce_menu_item_tier() refuses it below that tier.';
comment on column public.order_items.sale_unit is
  'The sale unit that applied WHEN THE ORDER WAS PLACED. Snapshotted like '
  'name and unit_price so historical reports never move.';

/* ---- 2. Backfill from the catalogue that exists ------------------------ */

/*
   Read from the real names rather than a hardcoded list of five products, so
   the backfill states the rule it is applying. Anchored on the suffix at the
   END of the name, which is where the convention actually lives — a loose
   '%scoop%' would also catch a description that merely mentions the word.
*/
update public.menu_items
   set sale_unit = 'scoop'
 where name ilike '%(per scoop)%'
   and sale_unit <> 'scoop';

update public.menu_items
   set sale_unit = 'cup'
 where name ilike '%(per cup)%'
   and sale_unit <> 'cup';

/* Historical order lines take the unit from the product they point at. The
   join is safe today: every existing order_items row still has a non-null
   menu_item_id. */
update public.order_items oi
   set sale_unit = mi.sale_unit
  from public.menu_items mi
 where mi.id = oi.menu_item_id
   and oi.sale_unit <> mi.sale_unit;

/* Belt and braces for any line whose product has since been deleted: fall
   back to the same naming rule, applied to the snapshotted line name. */
update public.order_items
   set sale_unit = 'scoop'
 where menu_item_id is null
   and name ilike '%(per scoop)%'
   and sale_unit <> 'scoop';

/* ---- 3. New order lines stamp themselves ------------------------------- */

/*
   A trigger rather than an edit to create_checkout_order(). The checkout RPC
   is the money path — it prices every line server-side and is the one place a
   mistake becomes a wrong charge — so it is left untouched. A BEFORE INSERT
   trigger also covers every other insert path that might ever exist, which an
   edit to one function would not.

   Only fills a value that was not supplied, so an explicit caller still wins.
*/
create or replace function public.stamp_order_item_sale_unit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.sale_unit is null or new.sale_unit = 'unit' then
    select mi.sale_unit into new.sale_unit
      from public.menu_items mi
     where mi.id = new.menu_item_id;
    if new.sale_unit is null then new.sale_unit := 'unit'; end if;
  end if;
  return new;
end;
$$;

revoke all on function public.stamp_order_item_sale_unit() from public, anon, authenticated;

drop trigger if exists order_items_stamp_sale_unit on public.order_items;
create trigger order_items_stamp_sale_unit
  before insert on public.order_items
  for each row execute function public.stamp_order_item_sale_unit();

/* ---- 4. Who may reclassify a product ----------------------------------- */

/* The column is writable at all only through the existing column grant. */
grant update (sale_unit) on public.menu_items to authenticated;

/*
   Extends the existing staff restriction rather than adding a second gate.
   sale_unit decides whether a product appears in the scoop report, so it is a
   reporting-integrity field, not an availability one — it belongs with price
   and name on the manager+ side of this function.
*/
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
     or new.sort_order  is distinct from old.sort_order
     or new.sale_unit   is distinct from old.sale_unit then
    raise exception 'Staff may only change item availability'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

/*
   And it is audited, the same way a price change already is. Reclassifying a
   product changes what every future daily report counts, so it is exactly the
   kind of quiet change an audit log exists for.
*/
create or replace function public.audit_menu_item_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    perform public.log_admin_action(
      'menu_item.delete', 'menu_items', old.id::text,
      'Deleted menu item "' || old.name || '" (' || old.price || ')',
      jsonb_build_object('name', old.name, 'price', old.price,
                         'category', old.category_id, 'status', old.status));
    return old;
  end if;

  if tg_op = 'INSERT' then
    perform public.log_admin_action(
      'menu_item.create', 'menu_items', new.id::text,
      'Created menu item "' || new.name || '" (' || new.price || ')',
      jsonb_build_object('name', new.name, 'price', new.price,
                         'category', new.category_id));
    return new;
  end if;

  if new.price is distinct from old.price then
    perform public.log_admin_action(
      'menu_item.price_change', 'menu_items', new.id::text,
      '"' || new.name || '" price ' || old.price || ' -> ' || new.price,
      jsonb_build_object('from', old.price, 'to', new.price, 'name', new.name));
  end if;

  if new.sale_unit is distinct from old.sale_unit then
    perform public.log_admin_action(
      'menu_item.sale_unit_change', 'menu_items', new.id::text,
      '"' || new.name || '" sold as ' || old.sale_unit || ' -> ' || new.sale_unit,
      jsonb_build_object('from', old.sale_unit, 'to', new.sale_unit, 'name', new.name));
  end if;

  return new;
end;
$$;

/* ---- 5. The report ----------------------------------------------------- */

/*
   ONE function, day-scoped, read-only, and shaped to be consumed later by the
   end-of-day report rather than to be a screen of its own.

   WHICH ORDERS COUNT, AND WHY
   ---------------------------
   Anchored on orders.created_at — the moment the food was sold. Not
   updated_at, which moves every time a status changes and would let an order
   drift between days.

     gross        every scoop ordered in the window, whatever its state.
     cancelled    the subset on Cancelled orders. Subtracted.
     net          gross - cancelled. The operational answer to "how many
                  scoops did we sell today".
     unpaid_open  ordered, not cancelled, not paid. Reported separately
                  because food that left the kitchen without payment is an
                  operational fact, not a rounding error.
     refunded     scoops on orders whose payment_status is 'refunded'.
                  Reported, NOT subtracted: admin_refund_order() sets
                  payment_status alone and never touches orders.status, so a
                  refunded order was still cooked and served. Refunds are a
                  money event; net scoops is a kitchen number. Subtracting
                  them here would invent a second definition of a sale, which
                  is exactly what this phase is meant to avoid.

   WHO SEES WHAT
   -------------
   is_admin() (staff and above) to call it at all. Revenue is present only for
   is_manager(), and is ABSENT rather than zero otherwise — the same rule
   admin_dashboard() already applies to its finance block, and for the same
   reason: a "N0" shown to someone who may not see money is still an answer
   about money.
*/
create or replace function public.admin_scoop_report(p_day date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_mgr   boolean := public.is_manager();
  v_from  timestamptz;
  v_to    timestamptz;
  v_rows  jsonb;
  v_tot   record;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  /* Africa/Lagos, the same boundary kt_today_start() gives the dashboard, so
     a scoop total and an order count can never describe different days. */
  v_from := case
              when p_day is null then public.kt_today_start()
              else (p_day::timestamp at time zone 'Africa/Lagos')
            end;
  v_to := v_from + interval '1 day';

  with lines as (
    select oi.qty,
           oi.line_total,
           oi.menu_item_id,
           coalesce(mi.name, oi.name) as product,
           o.status,
           o.paid,
           o.payment_status
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      left join public.menu_items mi on mi.id = oi.menu_item_id
     where oi.sale_unit = 'scoop'
       and o.created_at >= v_from
       and o.created_at <  v_to
  )
  select
    coalesce(sum(qty), 0)                                                    as g_q,
    coalesce(sum(line_total), 0)                                             as g_r,
    coalesce(sum(qty)       filter (where status = 'Cancelled'), 0)          as c_q,
    coalesce(sum(line_total) filter (where status = 'Cancelled'), 0)         as c_r,
    coalesce(sum(qty)       filter (where status <> 'Cancelled' and not paid), 0)  as u_q,
    coalesce(sum(line_total) filter (where status <> 'Cancelled' and not paid), 0) as u_r,
    coalesce(sum(qty)       filter (where payment_status = 'refunded'), 0)   as r_q,
    coalesce(sum(line_total) filter (where payment_status = 'refunded'), 0)  as r_r
    into v_tot
    from lines;

  /* Breakdown by product, ordered by what actually sold. Never a fixed list:
     marking a sixth product as a scoop puts it here with no code change. */
  with lines as (
    select oi.qty, oi.line_total, oi.menu_item_id,
           coalesce(mi.name, oi.name) as product, o.status
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      left join public.menu_items mi on mi.id = oi.menu_item_id
     where oi.sale_unit = 'scoop'
       and o.created_at >= v_from
       and o.created_at <  v_to
  ),
  per as (
    select product,
           min(menu_item_id::text)                                            as menu_item_id,
           sum(qty)                                                           as gross_scoops,
           coalesce(sum(qty) filter (where status = 'Cancelled'), 0)           as cancelled_scoops,
           sum(qty) - coalesce(sum(qty) filter (where status = 'Cancelled'), 0) as net_scoops,
           sum(line_total)
             - coalesce(sum(line_total) filter (where status = 'Cancelled'), 0) as net_revenue
      from lines
     group by product
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'product', product,
           'menu_item_id', menu_item_id,
           'gross_scoops', gross_scoops,
           'cancelled_scoops', cancelled_scoops,
           'net_scoops', net_scoops,
           'net_revenue', case when v_mgr then net_revenue else null end)
         order by net_scoops desc, product), '[]'::jsonb)
    into v_rows
    from per;

  return jsonb_build_object(
    'day',           (v_from at time zone 'Africa/Lagos')::date,
    'from',          v_from,
    'to',            v_to,
    'generated_at',  now(),
    'viewer_role',   public.auth_role(),
    'includes_revenue', v_mgr,
    'gross',       jsonb_build_object('scoops', v_tot.g_q,
                     'revenue', case when v_mgr then v_tot.g_r else null end),
    'cancelled',   jsonb_build_object('scoops', v_tot.c_q,
                     'revenue', case when v_mgr then v_tot.c_r else null end),
    'net',         jsonb_build_object('scoops', v_tot.g_q - v_tot.c_q,
                     'revenue', case when v_mgr then v_tot.g_r - v_tot.c_r else null end),
    'unpaid_open', jsonb_build_object('scoops', v_tot.u_q,
                     'revenue', case when v_mgr then v_tot.u_r else null end),
    'refunded',    jsonb_build_object('scoops', v_tot.r_q,
                     'revenue', case when v_mgr then v_tot.r_r else null end),
    'by_product',  v_rows);
end;
$$;

revoke all on function public.admin_scoop_report(date) from public, anon;
grant execute on function public.admin_scoop_report(date) to authenticated;

comment on function public.admin_scoop_report(date) is
  'Scoops sold in one Africa/Lagos day. Read-only. Staff+ for counts, '
  'manager+ for revenue. Shaped for reuse by the future end-of-day report.';

commit;
