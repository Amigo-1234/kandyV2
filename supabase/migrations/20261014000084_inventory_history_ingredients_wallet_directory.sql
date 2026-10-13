/* ==========================================================================
   0084 — Inventory history, ingredients, end-of-day index, wallet directory
   --------------------------------------------------------------------------
   Additive only. No existing row is updated or deleted, no existing function
   that settles money or takes an order is replaced, and nothing here changes
   menu availability.

   WHAT IS ADDED

   1. inventory_tracking_events — when each menu item started (or stopped)
      being stock-tracked. Lets history show an item only on the days it was
      actually tracked, so turning tracking on for proteins today does not
      make every past day look like "proteins were never entered".
      admin_set_stock_tracking() is the one-tap way to track an EXISTING
      menu item (no duplicate is ever created).

   2. admin_inventory_range() — a read-only, date-ranged history of the
      finished-dish ledger: per day and per dish, opening / prepared / sold /
      waste / staff meal / adjustment / expected / counted / variance, who
      recorded what, the notes, and which tracked dishes had no entry or no
      count. Same equation as admin_inventory_day(); a missing count is
      reported as missing (null), never as zero.

   3. Ingredients — a SEPARATE register (ingredients) and append-only ledger
      (ingredient_entries): received / used / waste / adjustment / count,
      each with a unit, a note, a server-set date and the person who recorded
      it. Nothing reads these tables to decide menu availability, and they do
      not reference menu_items at all.

   4. day_report_index() — which days have end-of-day reports, so past days
      can be found. Past reports stay read-only: staff_day_report_save()
      already refuses any day but today, and is not touched here.

   5. admin_wallet_directory() / admin_wallet_history() — owner/admin only.
      Customer names and contact details joined to the wallet ledger, with
      totals per ledger category, running balances, funding attempts that
      did not complete, and reconciliation flags. Read-only: no wallet,
      transaction, intent or order is written by either.
   ========================================================================== */

begin;

/* ---- 1. Stock-tracking history ----------------------------------------- */

create table if not exists public.inventory_tracking_events (
  id           bigserial primary key,
  menu_item_id uuid not null references public.menu_items (id) on delete restrict,
  tracked      boolean not null,
  actor_id     uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists inventory_tracking_events_item_idx
  on public.inventory_tracking_events (menu_item_id, created_at desc);

alter table public.inventory_tracking_events enable row level security;
revoke all on public.inventory_tracking_events from anon, authenticated;
grant select on public.inventory_tracking_events to authenticated;
drop policy if exists inventory_tracking_events_read on public.inventory_tracking_events;
create policy inventory_tracking_events_read on public.inventory_tracking_events
  for select to authenticated using ((select public.is_admin()));

/* Items tracked today have been tracked since inventory began: 0054 switched
   all seven on at activation. One baseline row each, once. */
insert into public.inventory_tracking_events (menu_item_id, tracked, actor_id, created_at)
select mi.id, true, null,
       coalesce(((select (s.value #>> '{}')::date from public.app_settings s
                   where s.key = 'inventory_activated_on')::timestamp
                 at time zone 'Africa/Lagos'), mi.created_at)
  from public.menu_items mi
 where mi.tracks_stock
   and not exists (select 1 from public.inventory_tracking_events e
                    where e.menu_item_id = mi.id);

/* Every later change is recorded, whichever screen made it (this RPC or the
   Menu management editor). */
create or replace function public.log_stock_tracking_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.tracks_stock)
     or (tg_op = 'UPDATE' and new.tracks_stock is distinct from old.tracks_stock) then
    insert into public.inventory_tracking_events (menu_item_id, tracked, actor_id)
    values (new.id, new.tracks_stock, auth.uid());
  end if;
  return null;
end;
$$;
revoke all on function public.log_stock_tracking_change() from public, anon, authenticated;

drop trigger if exists menu_items_tracking_log on public.menu_items;
create trigger menu_items_tracking_log
  after insert or update of tracks_stock on public.menu_items
  for each row execute function public.log_stock_tracking_change();

/* Menu items that could be tracked, for the "Track an existing item" picker.
   Trashed items are left out. Staff can see the list; only managers switch. */
create or replace function public.admin_inventory_candidates()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'can_change', public.is_manager(),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', mi.id, 'name', mi.name, 'category_id', mi.category_id,
               'sale_unit', mi.sale_unit, 'status', mi.status,
               'tracks_stock', mi.tracks_stock,
               'tracked_since', (select max(e.created_at) from public.inventory_tracking_events e
                                  where e.menu_item_id = mi.id and e.tracked),
               'has_history', exists (select 1 from public.inventory_movements m where m.menu_item_id = mi.id)
                           or exists (select 1 from public.inventory_counts c where c.menu_item_id = mi.id))
             order by mi.tracks_stock desc, mi.category_id, mi.name)
        from public.menu_items mi
       where mi.deleted_at is null), '[]'::jsonb));
end;
$$;
revoke all on function public.admin_inventory_candidates() from public, anon;
grant execute on function public.admin_inventory_candidates() to authenticated;

/* Switch tracking on (or off) for an existing menu item. Never creates an
   item. Turning tracking off keeps every past entry; history still shows
   the item on the days it has entries. Menu availability is not touched:
   it only follows stock when stock_availability_enabled is on, and even
   then only for dishes with a physical count. */
create or replace function public.admin_set_stock_tracking(p_menu_item_id uuid, p_tracked boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_item public.menu_items;
begin
  if not public.is_manager() then
    raise exception 'Only an admin or owner can change which items are tracked'
      using errcode = '42501';
  end if;
  select * into v_item from public.menu_items
   where id = p_menu_item_id and deleted_at is null
   for update;
  if v_item.id is null then
    raise exception 'That menu item does not exist' using errcode = 'P0002';
  end if;
  if v_item.tracks_stock = coalesce(p_tracked, false) then
    return jsonb_build_object('status', 'unchanged', 'id', v_item.id,
                              'tracks_stock', v_item.tracks_stock);
  end if;

  update public.menu_items set tracks_stock = coalesce(p_tracked, false)
   where id = v_item.id;

  perform public.log_admin_action(
    case when p_tracked then 'inventory.track' else 'inventory.untrack' end,
    'menu_items', v_item.id::text,
    v_item.name || case when p_tracked then ': stock tracking on' else ': stock tracking off' end,
    jsonb_build_object('menu_item_id', v_item.id, 'tracks_stock', coalesce(p_tracked, false)));

  return jsonb_build_object('status', 'ok', 'id', v_item.id,
                            'tracks_stock', coalesce(p_tracked, false));
end;
$$;
revoke all on function public.admin_set_stock_tracking(uuid, boolean) from public, anon;
grant execute on function public.admin_set_stock_tracking(uuid, boolean) to authenticated;

/* ---- 2. Inventory history ---------------------------------------------- */

/*
   Per day in [p_from, p_to] (Lagos business dates, at most 62 days, never
   past today), per dish that was tracked that day or has entries that day:
   the same figures admin_inventory_day() gives for a single day, plus who
   recorded entries, their notes, and whether the dish had no entry or no
   count. Days before inventory began report tracked=false, nothing more.

   Consumption here is the first time an order reached the kitchen, exactly
   as kt_inventory_consumption() defines it, but without its "tracked now"
   filter — so a dish whose tracking was later switched off still shows what
   was sold on the days it was tracked.
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
    select g::date as d,
           (g::date)::timestamp at time zone 'Africa/Lagos'       as lo,
           (g::date + 1)::timestamp at time zone 'Africa/Lagos'   as hi
      from generate_series(v_from, v_to, interval '1 day') g
  ),
  tracked_on as (
    select dy.d, e.menu_item_id
      from days dy
      cross join lateral (
        select distinct on (te.menu_item_id) te.menu_item_id, te.tracked
          from public.inventory_tracking_events te
         where te.created_at < dy.hi
         order by te.menu_item_id, te.created_at desc, te.id desc) e
     where e.tracked
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
  cnt as (
    select distinct on (c.business_date, c.menu_item_id)
           c.business_date as d, c.menu_item_id, c.qty, c.created_at,
           nullif(btrim(coalesce(p.display_name, '')), '') as actor
      from public.inventory_counts c
      left join public.profiles p on p.id = c.actor_id
     where c.business_date between v_from and v_to
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
    select d, menu_item_id from tracked_on
    union select d, menu_item_id from mv
    union select d, menu_item_id from cnt
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
    select s.d, s.menu_item_id, mi.name, mi.sale_unit,
           (t.menu_item_id is not null) as tracked_that_day,
           op.qty  as opening, op.business_date as opening_from,
           coalesce(mv.prepared, 0)   as prepared,
           coalesce(cs.qty, 0)        as consumed,
           coalesce(mv.waste, 0)      as waste,
           coalesce(mv.staff_meal, 0) as staff_meal,
           coalesce(mv.adjustment, 0) as adjustment,
           coalesce(mv.entries, 0)    as entries,
           cn.qty as counted, cn.created_at as counted_at, cn.actor as counted_by,
           coalesce(w.names, '[]'::jsonb) as recorded_by
      from scoped s
      join public.menu_items mi on mi.id = s.menu_item_id
      left join tracked_on t on t.d = s.d and t.menu_item_id = s.menu_item_id
      left join mv  on mv.d = s.d and mv.menu_item_id = s.menu_item_id
      left join cnt cn on cn.d = s.d and cn.menu_item_id = s.menu_item_id
      left join cons cs on cs.d = s.d and cs.menu_item_id = s.menu_item_id
      left join who w on w.d = s.d and w.menu_item_id = s.menu_item_id
      left join lateral (
        select ic.qty, ic.business_date
          from public.inventory_counts ic
         where ic.menu_item_id = s.menu_item_id and ic.business_date < s.d
         order by ic.business_date desc, ic.created_at desc
         limit 1) op on true
  ),
  item_json as (
    select c.d,
           jsonb_agg(jsonb_build_object(
             'menu_item_id', c.menu_item_id, 'name', c.name, 'sale_unit', c.sale_unit,
             'tracked_that_day', c.tracked_that_day,
             'opening', c.opening, 'opening_from', c.opening_from,
             'opening_established', c.opening is not null,
             'prepared', c.prepared, 'consumed', c.consumed, 'waste', c.waste,
             'staff_meal', c.staff_meal, 'adjustment', c.adjustment,
             'net_change', c.prepared + c.adjustment - c.consumed - c.waste - c.staff_meal,
             'expected_closing', case when c.opening is null then null
               else c.opening + c.prepared + c.adjustment - c.consumed - c.waste - c.staff_meal end,
             'counted', c.counted, 'counted_at', c.counted_at, 'counted_by', c.counted_by,
             'variance', case when c.opening is null or c.counted is null then null
               else c.counted - (c.opening + c.prepared + c.adjustment - c.consumed - c.waste - c.staff_meal) end,
             'entries', c.entries,
             'missing_entry', c.tracked_that_day and c.entries = 0,
             'missing_count', c.tracked_that_day and c.counted is null,
             'recorded_by', c.recorded_by)
             order by c.sale_unit, c.name) as items,
           count(*) as n_items,
           count(*) filter (where c.tracked_that_day and c.entries = 0) as missing_entries,
           count(*) filter (where c.tracked_that_day and c.counted is null) as missing_counts,
           count(*) filter (where c.counted is not null) as counted,
           sum(c.entries) as entries
      from calc c
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
        select c.business_date, c.id, 'count', 'count', c.qty, null, c.note,
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
    'viewer_role', public.auth_role(),
    'generated_at', now(),
    'days', v_days);
end;
$$;
revoke all on function public.admin_inventory_range(date, date, uuid) from public, anon;
grant execute on function public.admin_inventory_range(date, date, uuid) to authenticated;

/* ---- 3. Ingredients ----------------------------------------------------- */

/*
   Raw ingredients and supplies: rice by the bag, oil by the litre, packs by
   the carton. Deliberately unconnected to menu_items — an ingredient
   quantity never decides whether a dish is on sale.

   The register (ingredients) is editable by supervisors+: name, category,
   reorder level, notes, active. The unit is fixed once anything has been
   recorded, because changing it would change the meaning of every past
   entry. The ledger (ingredient_entries) is append-only at every tier, the
   same rule as the dish ledger: mistakes are corrected by a new entry.
*/
create table if not exists public.ingredients (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(btrim(name)) between 2 and 60),
  unit          text not null check (unit in (
                  'kg', 'g', 'litre', 'ml', 'piece', 'pack', 'bag', 'carton', 'crate',
                  'bottle', 'tin', 'sachet', 'tuber', 'bunch', 'basket', 'derica',
                  'mudu', 'bucket', 'cup', 'tray', 'roll')),
  category      text not null default 'other' check (category in (
                  'grains', 'proteins', 'vegetables', 'oils', 'spices', 'dairy',
                  'drinks', 'packaging', 'cleaning', 'other')),
  reorder_level numeric(12, 2) check (reorder_level is null or reorder_level >= 0),
  notes         text not null default '' check (char_length(notes) <= 500),
  active        boolean not null default true,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_by    uuid references public.profiles (id) on delete set null,
  updated_at    timestamptz not null default now()
);

/* One ingredient per name, whatever the spacing or capitals. */
create unique index if not exists ingredients_name_key
  on public.ingredients (lower(btrim(name)));

create table if not exists public.ingredient_entries (
  id            uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references public.ingredients (id) on delete restrict,
  business_date date not null,
  kind          text not null check (kind in ('received', 'used', 'waste', 'adjustment', 'count')),
  qty           numeric(12, 2) not null,
  /* The unit at the time of the entry, so the history reads correctly on
     its own. ingredient_save() refuses a unit change once entries exist. */
  unit          text not null,
  constraint ingredient_entries_sign check (
    case kind when 'adjustment' then qty <> 0
              when 'count'      then qty >= 0
              else qty > 0 end),
  reason        text,
  constraint ingredient_entries_reason_required check (
    kind in ('received', 'used', 'count') or nullif(btrim(coalesce(reason, '')), '') is not null),
  note          text not null default '' check (char_length(note) <= 500),
  corrects_id   uuid references public.ingredient_entries (id) on delete restrict,
  actor_id      uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists ingredient_entries_day_idx
  on public.ingredient_entries (business_date desc, ingredient_id);
create index if not exists ingredient_entries_item_idx
  on public.ingredient_entries (ingredient_id, created_at desc);

alter table public.ingredients enable row level security;
revoke all on public.ingredients from anon, authenticated;
grant select on public.ingredients to authenticated;
drop policy if exists ingredients_read on public.ingredients;
create policy ingredients_read on public.ingredients
  for select to authenticated using ((select public.is_admin()));

alter table public.ingredient_entries enable row level security;
revoke all on public.ingredient_entries from anon, authenticated;
grant select on public.ingredient_entries to authenticated;
drop policy if exists ingredient_entries_read on public.ingredient_entries;
create policy ingredient_entries_read on public.ingredient_entries
  for select to authenticated using ((select public.is_admin()));

/* Register a new ingredient (p_id null) or edit one. Supervisor+. */
create or replace function public.ingredient_save(
  p_id            uuid,
  p_name          text,
  p_unit          text,
  p_category      text default 'other',
  p_reorder_level numeric default null,
  p_notes         text default '',
  p_active        boolean default true
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_old  public.ingredients;
  v_id   uuid;
  v_dup  text;
begin
  if not public.is_supervisor() then
    raise exception 'Supervisors and above can add or edit ingredients' using errcode = '42501';
  end if;
  if char_length(v_name) < 2 then
    raise exception 'Enter the ingredient name' using errcode = '22023';
  end if;
  if char_length(v_name) > 60 then
    raise exception 'Keep the name to 60 characters or fewer' using errcode = '22023';
  end if;
  if p_unit is null or p_unit not in ('kg', 'g', 'litre', 'ml', 'piece', 'pack', 'bag', 'carton', 'crate',
                    'bottle', 'tin', 'sachet', 'tuber', 'bunch', 'basket', 'derica',
                    'mudu', 'bucket', 'cup', 'tray', 'roll') then
    raise exception 'Choose a unit of measurement' using errcode = '22023';
  end if;
  if coalesce(p_category, 'other') not in ('grains', 'proteins', 'vegetables', 'oils', 'spices', 'dairy',
                    'drinks', 'packaging', 'cleaning', 'other') then
    raise exception 'Choose a category' using errcode = '22023';
  end if;
  if p_reorder_level is not null and p_reorder_level < 0 then
    raise exception 'The reorder level cannot be negative' using errcode = '22023';
  end if;
  if char_length(coalesce(p_notes, '')) > 500 then
    raise exception 'Keep notes to 500 characters or fewer' using errcode = '22023';
  end if;

  select name into v_dup from public.ingredients
   where lower(btrim(name)) = lower(v_name) and (p_id is null or id <> p_id);
  if v_dup is not null then
    raise exception 'An ingredient called "%" already exists', v_dup using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.ingredients (name, unit, category, reorder_level, notes, active, created_by, updated_by)
    values (v_name, p_unit, coalesce(p_category, 'other'), p_reorder_level,
            btrim(coalesce(p_notes, '')), coalesce(p_active, true), auth.uid(), auth.uid())
    returning id into v_id;
    perform public.log_admin_action('ingredient.create', 'ingredients', v_id::text,
      'Ingredient added: ' || v_name || ' (' || p_unit || ')',
      jsonb_build_object('unit', p_unit, 'category', p_category));
  else
    select * into v_old from public.ingredients where id = p_id for update;
    if v_old.id is null then
      raise exception 'That ingredient does not exist' using errcode = 'P0002';
    end if;
    if p_unit is distinct from v_old.unit
       and exists (select 1 from public.ingredient_entries e where e.ingredient_id = p_id) then
      raise exception 'The unit cannot change once stock has been recorded for this ingredient'
        using errcode = '22023';
    end if;
    update public.ingredients
       set name = v_name, unit = p_unit, category = coalesce(p_category, 'other'),
           reorder_level = p_reorder_level, notes = btrim(coalesce(p_notes, '')),
           active = coalesce(p_active, true), updated_by = auth.uid(), updated_at = now()
     where id = p_id;
    v_id := p_id;
    perform public.log_admin_action('ingredient.update', 'ingredients', v_id::text,
      'Ingredient updated: ' || v_name,
      jsonb_build_object('before', to_jsonb(v_old) - 'created_by' - 'updated_by'));
  end if;

  return jsonb_build_object('status', 'ok', 'id', v_id);
exception
  when unique_violation then
    raise exception 'An ingredient with that name already exists' using errcode = '23505';
end;
$$;
revoke all on function public.ingredient_save(uuid, text, text, text, numeric, text, boolean) from public, anon;
grant execute on function public.ingredient_save(uuid, text, text, text, numeric, text, boolean) to authenticated;

/* The only write path into the ingredient ledger. Staff record received,
   used and waste; adjustments and counts are supervisor+, the same split as
   the dish ledger. Dated by the server. */
create or replace function public.ingredient_record(
  p_ingredient_id uuid,
  p_kind          text,
  p_qty           numeric,
  p_reason        text default null,
  p_note          text default '',
  p_corrects_id   uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_ing  public.ingredients;
  v_date date := (public.kt_today_start() at time zone 'Africa/Lagos')::date;
  v_id   uuid;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;
  if p_kind not in ('received', 'used', 'waste', 'adjustment', 'count') then
    raise exception 'Unknown entry type: %', p_kind using errcode = '22023';
  end if;
  if p_kind in ('adjustment', 'count') and not public.is_supervisor() then
    raise exception 'Adjustments and counts are available to supervisors and above'
      using errcode = '42501';
  end if;
  if p_qty is null then
    raise exception 'Enter a quantity' using errcode = '22023';
  end if;

  select * into v_ing from public.ingredients where id = p_ingredient_id;
  if v_ing.id is null then
    raise exception 'That ingredient does not exist' using errcode = 'P0002';
  end if;
  if not v_ing.active then
    raise exception '% is archived. Reactivate it to record stock.', v_ing.name using errcode = '22023';
  end if;
  if p_corrects_id is not null and not exists (
       select 1 from public.ingredient_entries
        where id = p_corrects_id and ingredient_id = p_ingredient_id) then
    raise exception 'No such entry to correct for this ingredient' using errcode = 'P0002';
  end if;

  insert into public.ingredient_entries
    (ingredient_id, business_date, kind, qty, unit, reason, note, corrects_id, actor_id)
  values
    (v_ing.id, v_date, p_kind, p_qty, v_ing.unit,
     nullif(btrim(coalesce(p_reason, '')), ''), btrim(coalesce(p_note, '')),
     p_corrects_id, auth.uid())
  returning id into v_id;

  perform public.log_admin_action('ingredient.' || p_kind, 'ingredient_entries', v_id::text,
    v_ing.name || ': ' || p_kind || ' ' || p_qty || ' ' || v_ing.unit,
    jsonb_build_object('ingredient_id', v_ing.id, 'kind', p_kind, 'qty', p_qty,
                       'reason', p_reason, 'business_date', v_date));

  return jsonb_build_object('status', 'ok', 'id', v_id, 'business_date', v_date);
end;
$$;
revoke all on function public.ingredient_record(uuid, text, numeric, text, text, uuid) from public, anon;
grant execute on function public.ingredient_record(uuid, text, numeric, text, text, uuid) to authenticated;

/*
   The register as at the end of p_day (today when null). For each
   ingredient:
     on_hand       the newest count up to that moment plus everything
                   received / adjusted minus used / wasted AFTER that count.
                   NULL when the ingredient has never been counted — "never
                   counted" is not "none left", and is not shown as zero.
     day_*         that day's totals, and whether it was entered / counted.
     low           on_hand known and at or below the reorder level.
*/
create or replace function public.admin_ingredients(p_day date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := (public.kt_today_start() at time zone 'Africa/Lagos')::date;
  v_date  date := least(coalesce(p_day, v_today), v_today);
  v_end   timestamptz := (v_date + 1)::timestamp at time zone 'Africa/Lagos';
  v_rows  jsonb;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  with base as (
    select i.* from public.ingredients i
     where i.created_at < v_end
        or exists (select 1 from public.ingredient_entries e
                    where e.ingredient_id = i.id and e.business_date <= v_date)
  ),
  last_count as (
    select distinct on (e.ingredient_id) e.ingredient_id, e.qty, e.created_at, e.business_date,
           nullif(btrim(coalesce(p.display_name, '')), '') as actor
      from public.ingredient_entries e
      left join public.profiles p on p.id = e.actor_id
     where e.kind = 'count' and e.created_at < v_end
     order by e.ingredient_id, e.created_at desc, e.id desc
  ),
  since as (
    select e.ingredient_id,
           sum(case e.kind when 'received' then e.qty when 'adjustment' then e.qty
                           when 'used' then -e.qty when 'waste' then -e.qty else 0 end) as net
      from public.ingredient_entries e
      left join last_count lc on lc.ingredient_id = e.ingredient_id
     where e.kind <> 'count' and e.created_at < v_end
       and (lc.created_at is null or e.created_at > lc.created_at)
     group by e.ingredient_id
  ),
  dayt as (
    select e.ingredient_id,
           sum(e.qty) filter (where e.kind = 'received')   as received,
           sum(e.qty) filter (where e.kind = 'used')       as used,
           sum(e.qty) filter (where e.kind = 'waste')      as waste,
           sum(e.qty) filter (where e.kind = 'adjustment') as adjustment,
           (array_agg(e.qty order by e.created_at desc) filter (where e.kind = 'count'))[1] as counted,
           count(*) filter (where e.kind <> 'count') as entries,
           count(*) filter (where e.note <> '') as notes,
           max(e.created_at) as last_at,
           jsonb_agg(distinct nullif(btrim(coalesce(p.display_name, '')), ''))
             filter (where nullif(btrim(coalesce(p.display_name, '')), '') is not null) as people
      from public.ingredient_entries e
      left join public.profiles p on p.id = e.actor_id
     where e.business_date = v_date
     group by e.ingredient_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'name', b.name, 'unit', b.unit, 'category', b.category,
           'reorder_level', b.reorder_level, 'notes', b.notes, 'active', b.active,
           'created_at', b.created_at,
           'has_entries', exists (select 1 from public.ingredient_entries e where e.ingredient_id = b.id),
           'on_hand', case when lc.ingredient_id is null then null else lc.qty + coalesce(s.net, 0) end,
           'counted_ever', lc.ingredient_id is not null,
           'net_without_count', case when lc.ingredient_id is null then coalesce(s.net, 0) end,
           'last_count', case when lc.ingredient_id is null then null else jsonb_build_object(
              'qty', lc.qty, 'business_date', lc.business_date, 'at', lc.created_at, 'by', lc.actor) end,
           'low', lc.ingredient_id is not null and b.reorder_level is not null
                  and lc.qty + coalesce(s.net, 0) <= b.reorder_level,
           'day', jsonb_build_object(
              'received', coalesce(d.received, 0), 'used', coalesce(d.used, 0),
              'waste', coalesce(d.waste, 0), 'adjustment', coalesce(d.adjustment, 0),
              'counted', d.counted, 'entries', coalesce(d.entries, 0),
              'notes', coalesce(d.notes, 0), 'last_at', d.last_at,
              'people', coalesce(d.people, '[]'::jsonb),
              'missing_entry', b.active and coalesce(d.entries, 0) = 0,
              'missing_count', b.active and d.counted is null))
         order by b.active desc, b.category, b.name), '[]'::jsonb)
    into v_rows
    from base b
    left join last_count lc on lc.ingredient_id = b.id
    left join since s on s.ingredient_id = b.id
    left join dayt d on d.ingredient_id = b.id;

  return jsonb_build_object(
    'business_date', v_date, 'today', v_today, 'is_today', v_date = v_today,
    'viewer_role', public.auth_role(),
    'can_manage', public.is_supervisor(),
    'items', v_rows);
end;
$$;
revoke all on function public.admin_ingredients(date) from public, anon;
grant execute on function public.admin_ingredients(date) to authenticated;

/* Ingredient entries in a date range, newest first, with filters. */
create or replace function public.admin_ingredient_history(
  p_from date default null, p_to date default null,
  p_ingredient_id uuid default null, p_kind text default null,
  p_search text default null, p_limit integer default 300
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := (public.kt_today_start() at time zone 'Africa/Lagos')::date;
  v_to    date := least(coalesce(p_to, v_today), v_today);
  v_from  date := coalesce(p_from, v_to - 6);
  v_q     text := nullif(btrim(coalesce(p_search, '')), '');
  v_rows  jsonb;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;
  if v_from > v_to then
    raise exception 'The start date must be on or before the end date' using errcode = '22023';
  end if;
  if v_to - v_from > 366 then
    raise exception 'Choose a range of a year or less' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) into v_rows
    from (
      select e.id, e.business_date, e.kind, e.qty, e.unit, e.reason, e.note, e.corrects_id,
             e.created_at, e.ingredient_id, i.name as ingredient, i.category,
             nullif(btrim(coalesce(p.display_name, '')), '') as actor, p.role as actor_role
        from public.ingredient_entries e
        join public.ingredients i on i.id = e.ingredient_id
        left join public.profiles p on p.id = e.actor_id
       where e.business_date between v_from and v_to
         and (p_ingredient_id is null or e.ingredient_id = p_ingredient_id)
         and (p_kind is null or e.kind = p_kind)
         and (v_q is null
              or i.name ilike '%' || v_q || '%'
              or e.note ilike '%' || v_q || '%'
              or coalesce(e.reason, '') ilike '%' || v_q || '%'
              or coalesce(p.display_name, '') ilike '%' || v_q || '%')
       order by e.created_at desc
       limit greatest(1, least(coalesce(p_limit, 300), 1000))
    ) x;

  return jsonb_build_object('from', v_from, 'to', v_to, 'rows', v_rows);
end;
$$;
revoke all on function public.admin_ingredient_history(date, date, uuid, text, text, integer) from public, anon;
grant execute on function public.admin_ingredient_history(date, date, uuid, text, text, integer) to authenticated;

/* ---- 4. End-of-day index ----------------------------------------------- */

/*
   Which days have reports, newest first, so a past day can be found and
   opened. Everyone sees their own status per day; supervisors+ also get the
   team's counts. Read-only — opening a past day uses the existing
   staff_day_report(p_day) / admin_day_reports(p_day).
*/
create or replace function public.day_report_index(p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := (public.kt_today_start() at time zone 'Africa/Lagos')::date;
  v_to    date := least(coalesce(p_to, v_today), v_today);
  v_from  date := coalesce(p_from, v_to - 13);
  v_sup   boolean := public.is_supervisor();
  v_rows  jsonb;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;
  if v_from > v_to then
    raise exception 'The start date must be on or before the end date' using errcode = '22023';
  end if;
  if v_to - v_from > 92 then
    raise exception 'Choose a range of 93 days or fewer' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'business_date', g.d,
           'is_today', g.d = v_today,
           'mine', (select jsonb_build_object('status', r.status, 'submitted_at', r.submitted_at,
                                              'reviewed', r.reviewed_at is not null,
                                              'needs_follow_up', r.needs_follow_up)
                      from public.staff_day_reports r
                     where r.staff_id = auth.uid() and r.business_date = g.d),
           'team', case when v_sup then (
              select jsonb_build_object(
                'submitted', count(*) filter (where r.status = 'submitted'),
                'drafts',    count(*) filter (where r.status = 'draft'),
                'reviewed',  count(*) filter (where r.reviewed_at is not null),
                'follow_up', count(*) filter (where r.needs_follow_up))
                from public.staff_day_reports r where r.business_date = g.d) end)
         order by g.d desc), '[]'::jsonb)
    into v_rows
    from (select d::date as d from generate_series(v_from, v_to, interval '1 day') d) g;

  return jsonb_build_object('from', v_from, 'to', v_to, 'today', v_today,
                            'is_supervisor', v_sup, 'days', v_rows);
end;
$$;
revoke all on function public.day_report_index(date, date) from public, anon;
grant execute on function public.day_report_index(date, date) to authenticated;

/* ---- 5. Wallet directory and history ----------------------------------- */

/*
   Owner/admin only (is_manager()). Customers never reach these: they are
   refused before any row is read, and neither function takes a caller's
   own id as a shortcut.

   Ledger categories, from wallet_transactions.type/reason as stored:
     funding            credit · funding       (Paystack top-ups)
     payments           debit  · order_payment (orders paid from the wallet)
     refunds            refund (either direction, shown separately)
     adjustments        adjustment (owner corrections; credit and debit kept apart)
     partner_commission credit · reward, reference 'partner-referral:…'
     rewards            any other reward (points converted to credit)
   Nothing is inferred beyond those stored fields.
*/
create or replace function public.kt_wallet_ledger_totals()
returns table (
  user_id uuid, funding bigint, funding_n bigint, payments bigint, payments_n bigint,
  refunds_in bigint, refunds_out bigint, adjust_in bigint, adjust_out bigint,
  partner bigint, rewards bigint, other_in bigint, other_out bigint,
  net bigint, tx_n bigint, last_at timestamptz, last_after integer)
language sql stable security definer set search_path = public as $$
  select t.user_id,
         coalesce(sum(t.amount) filter (where t.type = 'credit' and t.reason = 'funding'), 0),
         count(*) filter (where t.type = 'credit' and t.reason = 'funding'),
         coalesce(sum(t.amount) filter (where t.type = 'debit' and t.reason = 'order_payment'), 0),
         count(*) filter (where t.type = 'debit' and t.reason = 'order_payment'),
         coalesce(sum(t.amount) filter (where t.type = 'credit' and t.reason = 'refund'), 0),
         coalesce(sum(t.amount) filter (where t.type = 'debit' and t.reason = 'refund'), 0),
         coalesce(sum(t.amount) filter (where t.type = 'credit' and t.reason = 'adjustment'), 0),
         coalesce(sum(t.amount) filter (where t.type = 'debit' and t.reason = 'adjustment'), 0),
         coalesce(sum(t.amount) filter (where t.type = 'credit' and t.reason = 'reward'
                                          and t.reference like 'partner-referral:%'), 0),
         coalesce(sum(t.amount) filter (where t.type = 'credit' and t.reason = 'reward'
                                          and coalesce(t.reference, '') not like 'partner-referral:%'), 0),
         coalesce(sum(t.amount) filter (where t.type = 'credit'
                                          and t.reason not in ('funding', 'refund', 'adjustment', 'reward')), 0),
         coalesce(sum(t.amount) filter (where t.type = 'debit'
                                          and t.reason not in ('order_payment', 'refund', 'adjustment')), 0),
         coalesce(sum(case when t.type = 'credit' then t.amount else -t.amount end), 0),
         count(*),
         max(t.created_at),
         (array_agg(t.balance_after order by t.created_at desc, t.id desc))[1]
    from public.wallet_transactions t
   group by t.user_id;
$$;
revoke all on function public.kt_wallet_ledger_totals() from public, anon, authenticated;

create or replace function public.admin_wallet_directory(
  p_search text default null, p_filter text default 'activity',
  p_limit integer default 50, p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_q      text := nullif(btrim(coalesce(p_search, '')), '');
  v_filter text := coalesce(nullif(p_filter, ''), 'activity');
  v_limit  integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_rows   jsonb;
  v_match  integer;
  v_totals jsonb;
begin
  if not public.is_manager() then
    raise exception 'Only an admin or owner can view customer wallets' using errcode = '42501';
  end if;
  if v_filter not in ('activity', 'balance', 'attempts', 'mismatch', 'all') then
    raise exception 'Unknown filter: %', v_filter using errcode = '22023';
  end if;

  with d as (
    select w.user_id,
           nullif(btrim(coalesce(p.display_name, '')), '') as name,
           u.email::text as email,
           nullif(btrim(coalesce(p.phone, '')), '') as phone,
           p.role,
           p.suspended_at is not null as suspended,
           w.balance, w.available_balance as available, w.locked_balance as locked,
           w.status, w.updated_at,
           coalesce(l.funding, 0) as funding, coalesce(l.funding_n, 0) as funding_n,
           coalesce(l.payments, 0) as payments, coalesce(l.payments_n, 0) as payments_n,
           coalesce(l.refunds_in, 0) as refunds_in, coalesce(l.refunds_out, 0) as refunds_out,
           coalesce(l.adjust_in, 0) as adjust_in, coalesce(l.adjust_out, 0) as adjust_out,
           coalesce(l.partner, 0) as partner, coalesce(l.rewards, 0) as rewards,
           coalesce(l.other_in, 0) as other_in, coalesce(l.other_out, 0) as other_out,
           coalesce(l.net, 0) as net, coalesce(l.tx_n, 0) as tx_n, l.last_at,
           l.last_after,
           coalesce(a.n, 0) as attempts, coalesce(a.amount, 0) as attempts_amount,
           (w.balance = coalesce(l.net, 0)
             and (l.last_after is null or l.last_after = w.balance)) as reconciled
      from public.wallets w
      left join public.profiles p on p.id = w.user_id
      left join auth.users u on u.id = w.user_id
      left join public.kt_wallet_ledger_totals() l on l.user_id = w.user_id
      left join lateral (
        select count(*) as n, sum(i.amount) as amount
          from public.wallet_funding_intents i
         where i.user_id = w.user_id and i.status <> 'paid') a on true
  ),
  f as (
    select d.* from d
     where (v_filter = 'all'
            or (v_filter = 'activity' and (d.tx_n > 0 or d.attempts > 0))
            or (v_filter = 'balance'  and d.balance <> 0)
            or (v_filter = 'attempts' and d.attempts > 0)
            or (v_filter = 'mismatch' and not d.reconciled))
       and (v_q is null
            or d.name  ilike '%' || v_q || '%'
            or d.email ilike '%' || v_q || '%'
            or d.phone ilike '%' || v_q || '%'
            or regexp_replace(coalesce(d.phone, ''), '\D', '', 'g')
                 like '%' || nullif(regexp_replace(v_q, '\D', '', 'g'), '') || '%'
            or d.user_id::text ilike v_q || '%')
  )
  select
    (select jsonb_build_object(
       'wallets',            count(*),
       'balance_total',      coalesce(sum(balance), 0),
       'available_total',    coalesce(sum(available), 0),
       'locked_total',       coalesce(sum(locked), 0),
       'ledger_net_total',   coalesce(sum(net), 0),
       'funding_total',      coalesce(sum(funding), 0),
       'funding_count',      coalesce(sum(funding_n), 0),
       'payments_total',     coalesce(sum(payments), 0),
       'payments_count',     coalesce(sum(payments_n), 0),
       'refunds_in_total',   coalesce(sum(refunds_in), 0),
       'refunds_out_total',  coalesce(sum(refunds_out), 0),
       'adjust_in_total',    coalesce(sum(adjust_in), 0),
       'adjust_out_total',   coalesce(sum(adjust_out), 0),
       'partner_total',      coalesce(sum(partner), 0),
       'rewards_total',      coalesce(sum(rewards), 0),
       'other_in_total',     coalesce(sum(other_in), 0),
       'other_out_total',    coalesce(sum(other_out), 0),
       'with_activity',      count(*) filter (where tx_n > 0 or attempts > 0),
       'with_balance',       count(*) filter (where balance <> 0),
       'attempts',           coalesce(sum(attempts), 0),
       'attempts_amount',    coalesce(sum(attempts_amount), 0),
       'mismatched',         count(*) filter (where not reconciled),
       'reconciled',         count(*) filter (where not reconciled) = 0
                             and coalesce(sum(balance), 0) = coalesce(sum(net), 0))
       from d),
    (select count(*) from f),
    coalesce((select jsonb_agg(to_jsonb(x) - 'last_after' order by x.last_at desc nulls last, x.balance desc, x.name)
                from (select * from f order by last_at desc nulls last, balance desc, name
                       limit v_limit offset v_offset) x), '[]'::jsonb)
    into v_totals, v_match, v_rows;

  /* Every paid Paystack top-up should have exactly one funding credit with
     the same amount, and every funding credit a paid top-up behind it. */
  v_totals := v_totals || jsonb_build_object(
    'paid_intents',        (select count(*) from public.wallet_funding_intents where status = 'paid'),
    'paid_intents_amount', (select coalesce(sum(amount), 0) from public.wallet_funding_intents where status = 'paid'),
    'paid_intents_unmatched', (select count(*) from public.wallet_funding_intents i
                                where i.status = 'paid'
                                  and not exists (select 1 from public.wallet_transactions t
                                                   where t.reference = 'paystack:' || i.reference
                                                     and t.type = 'credit' and t.reason = 'funding'
                                                     and t.amount = i.amount)),
    'funding_without_intent', (select count(*) from public.wallet_transactions t
                                where t.type = 'credit' and t.reason = 'funding'
                                  and not exists (select 1 from public.wallet_funding_intents i
                                                   where 'paystack:' || i.reference = t.reference
                                                     and i.status = 'paid')),
    'transactions_without_wallet', (select count(distinct t.user_id) from public.wallet_transactions t
                                     where not exists (select 1 from public.wallets w where w.user_id = t.user_id)));
  v_totals := v_totals || jsonb_build_object('reconciled',
    (v_totals ->> 'reconciled')::boolean
    and (v_totals ->> 'paid_intents_unmatched')::int = 0
    and (v_totals ->> 'funding_without_intent')::int = 0
    and (v_totals ->> 'transactions_without_wallet')::int = 0);

  return jsonb_build_object(
    'filter', v_filter, 'search', v_q, 'limit', v_limit, 'offset', v_offset,
    'matching', v_match, 'totals', v_totals, 'rows', v_rows,
    'generated_at', now());
end;
$$;
revoke all on function public.admin_wallet_directory(text, text, integer, integer) from public, anon;
grant execute on function public.admin_wallet_directory(text, text, integer, integer) to authenticated;

/*
   One customer's complete wallet history. Every ledger row oldest-first,
   with the order code it paid for, its reference, the balance the ledger
   stored after it and a running balance recomputed from the rows — the two
   are compared and any disagreement is flagged, not hidden. Funding attempts
   that never settled are listed separately: none of them moved money into
   the wallet. The view itself is written to the audit log.
*/
create or replace function public.admin_wallet_history(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prof  public.profiles;
  v_email text;
  v_wal   public.wallets;
  v_tx    jsonb;
  v_att   jsonb;
  v_sum   jsonb;
  v_bad   integer;
begin
  if not public.is_manager() then
    raise exception 'Only an admin or owner can view customer wallets' using errcode = '42501';
  end if;

  select * into v_prof from public.profiles where id = p_user_id;
  if v_prof.id is null then
    raise exception 'No such customer' using errcode = 'P0002';
  end if;
  select email::text into v_email from auth.users where id = p_user_id;
  select * into v_wal from public.wallets where user_id = p_user_id;

  with tx as (
    select t.*, o.code as order_code, o.status as order_status, o.total as order_total,
           o.payment_status as order_payment_status,
           sum(case when t.type = 'credit' then t.amount else -t.amount end)
             over (order by t.created_at, t.id) as running
      from public.wallet_transactions t
      left join public.orders o on o.id = t.order_id
     where t.user_id = p_user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'created_at', x.created_at, 'type', x.type, 'reason', x.reason,
           'category', case
               when x.reason = 'funding' then 'funding'
               when x.reason = 'order_payment' then 'payment'
               when x.reason = 'refund' then 'refund'
               when x.reason = 'adjustment' then 'adjustment'
               when x.reason = 'reward' and x.reference like 'partner-referral:%' then 'partner_commission'
               when x.reason = 'reward' then 'reward'
               else 'other' end,
           'amount', x.amount,
           'signed', case when x.type = 'credit' then x.amount else -x.amount end,
           'balance_after', x.balance_after,
           'running', x.running,
           'running_ok', x.running = x.balance_after,
           'status', 'completed',
           'reference', x.reference, 'description', x.description,
           'order_id', x.order_id, 'order_code', x.order_code,
           'order_status', x.order_status, 'order_total', x.order_total,
           'order_payment_status', x.order_payment_status)
         order by x.created_at, x.id), '[]'::jsonb),
         count(*) filter (where x.running <> x.balance_after)
    into v_tx, v_bad
    from tx x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', i.id, 'reference', i.reference, 'amount', i.amount, 'status', i.status,
           'created_at', i.created_at, 'settled_at', i.settled_at,
           'money_received', false,
           'awaiting', i.status = 'pending' and i.created_at > now() - interval '1 hour')
         order by i.created_at desc), '[]'::jsonb)
    into v_att
    from public.wallet_funding_intents i
   where i.user_id = p_user_id and i.status <> 'paid';

  select jsonb_build_object(
           'funding', coalesce(l.funding, 0), 'funding_count', coalesce(l.funding_n, 0),
           'payments', coalesce(l.payments, 0), 'payments_count', coalesce(l.payments_n, 0),
           'refunds_in', coalesce(l.refunds_in, 0), 'refunds_out', coalesce(l.refunds_out, 0),
           'adjust_in', coalesce(l.adjust_in, 0), 'adjust_out', coalesce(l.adjust_out, 0),
           'partner_commission', coalesce(l.partner, 0), 'rewards', coalesce(l.rewards, 0),
           'other_in', coalesce(l.other_in, 0), 'other_out', coalesce(l.other_out, 0),
           'ledger_net', coalesce(l.net, 0), 'transactions', coalesce(l.tx_n, 0),
           'last_at', l.last_at)
    into v_sum
    from (select 1) one
    left join public.kt_wallet_ledger_totals() l on l.user_id = p_user_id;

  perform public.log_admin_action('finance.wallet_view', 'wallets', p_user_id::text,
    'Viewed wallet history: ' || coalesce(nullif(btrim(v_prof.display_name), ''), p_user_id::text),
    '{}'::jsonb);

  return jsonb_build_object(
    'customer', jsonb_build_object(
      'id', v_prof.id, 'name', nullif(btrim(coalesce(v_prof.display_name, '')), ''),
      'email', v_email, 'phone', nullif(btrim(coalesce(v_prof.phone, '')), ''),
      'role', v_prof.role, 'joined', v_prof.created_at,
      'suspended', v_prof.suspended_at is not null),
    'wallet', case when v_wal.user_id is null then null else jsonb_build_object(
      'balance', v_wal.balance, 'available', v_wal.available_balance,
      'locked', v_wal.locked_balance, 'status', v_wal.status, 'currency', v_wal.currency,
      'updated_at', v_wal.updated_at) end,
    'summary', v_sum,
    'reconciliation', jsonb_build_object(
      'balance', coalesce(v_wal.balance, 0),
      'ledger_net', coalesce((v_sum ->> 'ledger_net')::bigint, 0),
      'balance_matches_ledger', coalesce(v_wal.balance, 0) = coalesce((v_sum ->> 'ledger_net')::bigint, 0),
      'running_mismatches', v_bad,
      'ok', coalesce(v_wal.balance, 0) = coalesce((v_sum ->> 'ledger_net')::bigint, 0) and v_bad = 0),
    'transactions', v_tx,
    'attempts', v_att,
    'generated_at', now());
end;
$$;
revoke all on function public.admin_wallet_history(uuid) from public, anon;
grant execute on function public.admin_wallet_history(uuid) to authenticated;

commit;
