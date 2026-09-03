/* ==========================================================================
   Inventory ledger — foundation
   --------------------------------------------------------------------------
   Physical stock for the seven batch-cooked products. Orders remain the only
   record of a sale; this records what orders cannot know — how much was
   cooked, how much was thrown away, how much staff ate, and what was actually
   on the counter when someone looked.

   THREE RULES THIS SCHEMA ENFORCES RATHER THAN ASKS FOR

   1. The ledger is append-only. There is no UPDATE or DELETE grant on
      inventory_movements at any tier. A mistake is corrected by a new
      movement that points at the one it corrects, so the error and its
      correction are both still there afterwards.

   2. Direction is a property of the KIND, not of the number. prepared, waste
      and staff_meal all take a positive magnitude and the arithmetic decides
      the sign; only `adjustment` may carry one, and only supervisor+ may
      write an adjustment. Without that, a staff member could record
      "prepared: -50" and have made a negative adjustment through a door
      meant to be locked.

   3. A movement's business_date is computed on the server from the clock, not
      taken from the caller. Backdating a preparation into yesterday would
      rewrite a variance somebody has already reviewed.

   WHAT IS DELIBERATELY NOT HERE
   Ingredients, recipes, vessel yields, suppliers, valuation, and any
   automatic change to menu_items.status. Inventory and storefront
   availability stay separate systems in this phase.
   ========================================================================== */

begin;

/* ---- 1. Which products are tracked ------------------------------------- */

/*
   An explicit flag rather than `sale_unit in ('scoop','cup')`. sale_unit is a
   pricing/reporting attribute a manager may edit from the menu screen, and
   scoping the ledger on it would mean that reclassifying a product silently
   moved it in or out of inventory — changing what every past day's variance
   meant. Tracking stock is its own decision, so it gets its own column.
*/
alter table public.menu_items
  add column if not exists tracks_stock boolean not null default false;

comment on column public.menu_items.tracks_stock is
  'Whether physical stock is tracked for this product. Independent of '
  'sale_unit on purpose. Manager+ only — see enforce_menu_item_tier().';

/* The seven batch-cooked products, named from the live catalogue rather than
   hardcoded ids: five sold per scoop, two per cup. */
update public.menu_items
   set tracks_stock = true
 where sale_unit in ('scoop', 'cup')
   and tracks_stock = false;

/* Reclassifying a product in or out of inventory is a manager decision, for
   the same reason sale_unit is: it changes what the daily report counts. */
grant update (tracks_stock) on public.menu_items to authenticated;

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
     or new.sale_unit   is distinct from old.sale_unit
     or new.tracks_stock is distinct from old.tracks_stock then
    raise exception 'Staff may only change item availability'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

/* ---- 2. When tracking began -------------------------------------------- */

/*
   Before this date there is no inventory history and none will be invented.
   A report for an earlier day says "not tracked" rather than showing zeros,
   which would read as "nothing was cooked or wasted that day".

   Stored in app_settings because that table already exists for exactly this
   kind of operational constant, is already admin-gated for writes, and is
   already public-read — a date is not a secret.
*/
insert into public.app_settings (key, value)
values ('inventory_activated_on',
        to_jsonb((public.kt_today_start() at time zone 'Africa/Lagos')::date))
on conflict (key) do nothing;

/* ---- 3. The ledger ------------------------------------------------------ */

create table if not exists public.inventory_movements (
  id            uuid primary key default gen_random_uuid(),
  menu_item_id  uuid not null references public.menu_items (id) on delete restrict,
  business_date date not null,

  kind text not null check (kind in ('prepared', 'waste', 'staff_meal', 'adjustment')),

  /* Fractions are real: half a tray of rice is a legitimate waste entry. */
  qty numeric(10, 2) not null,

  /*
     Sign belongs to the kind. The three kinds staff may write take a positive
     magnitude and the daily equation applies their direction; only an
     adjustment — supervisor+ — may be negative. This is the constraint that
     stops "prepared: -50" being a back door to an adjustment.
  */
  constraint inventory_movements_sign check (
    case kind
      when 'adjustment' then qty <> 0
      else qty > 0
    end
  ),

  reason text,
  /* Waste and adjustments must say why. Preparation and a staff meal are
     self-explanatory, so a reason there is optional. */
  constraint inventory_movements_reason_required check (
    kind in ('prepared', 'staff_meal') or nullif(btrim(coalesce(reason, '')), '') is not null
  ),

  note       text not null default '',
  /* A correction points at what it corrects. The original is never touched. */
  corrects_id uuid references public.inventory_movements (id) on delete restrict,

  actor_id   uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists inventory_movements_day_idx
  on public.inventory_movements (business_date, menu_item_id);
create index if not exists inventory_movements_item_idx
  on public.inventory_movements (menu_item_id, business_date desc);

comment on table public.inventory_movements is
  'Append-only stock ledger. No UPDATE or DELETE grant exists at any tier; '
  'mistakes are corrected by a new movement carrying corrects_id.';

/* ---- 4. Physical counts are observations, not movements ---------------- */

/*
   Deliberately a separate table. A movement is a change to stock; a count is
   a statement about the world at a moment. Sharing one signed column between
   them would mean sum(qty) silently included absolute measurements, and the
   variance this whole system exists to produce is precisely
   "count MINUS what the movements said" — so the two must stay apart.
*/
create table if not exists public.inventory_counts (
  id            uuid primary key default gen_random_uuid(),
  menu_item_id  uuid not null references public.menu_items (id) on delete restrict,
  business_date date not null,
  qty           numeric(10, 2) not null check (qty >= 0),
  note          text not null default '',
  actor_id      uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists inventory_counts_day_idx
  on public.inventory_counts (business_date desc, menu_item_id);

comment on table public.inventory_counts is
  'A physical observation: "I counted X at this moment." Never converted into '
  'a movement. The newest count for a day is that day''s closing, and becomes '
  'the next tracked day''s opening.';

/* ---- 5. Access --------------------------------------------------------- */

/*
   SELECT for handlers, nothing else. Every write goes through a SECURITY
   DEFINER function below, which is what makes "staff cannot adjust", "nobody
   can edit history" and "nobody can backdate" true at the grant level rather
   than in the UI.
*/
alter table public.inventory_movements enable row level security;
revoke all on public.inventory_movements from anon, authenticated;
grant select on public.inventory_movements to authenticated;
create policy inventory_movements_read on public.inventory_movements
  for select to authenticated using ((select public.is_admin()));

alter table public.inventory_counts enable row level security;
revoke all on public.inventory_counts from anon, authenticated;
grant select on public.inventory_counts to authenticated;
create policy inventory_counts_read on public.inventory_counts
  for select to authenticated using ((select public.is_admin()));

/* ---- 6. Consumption: when the kitchen was reached ---------------------- */

/*
   THE CENTRAL DECISION OF THIS PHASE.

   Food is consumed when it is cooked, not when it is paid for or delivered.
   The moment is therefore the FIRST time an order entered a kitchen state —
   the earliest order_status_history row whose status is Preparing, Out or
   Completed. Not the order's final status, and not its completion time.

   What that gives, matching the four cases in the brief:

     New -> Cancelled                     never reached the kitchen -> 0
     New -> Preparing -> Cancelled        reached it -> consumed
     New -> Preparing -> Out -> Completed reached it -> consumed
     Completed, later refunded            still consumed. A refund moves
                                          money; it does not return food.

   Three statuses rather than just 'Preparing' because it costs nothing and
   does not depend on the state machine never gaining a path that skips it.
   The MIN() also makes payment-settlement rows harmless: those write a
   history row carrying the order's CURRENT status, so an order already in
   Preparing can gain a second Preparing row — the earliest is still the one
   the kitchen started on.

   The business date is the Lagos day of that timestamp, so an order placed
   at 23:50 and started at 00:10 is consumed on the day it was cooked. Same
   boundary kt_today_start() gives the dashboard and the scoop report.
*/
create or replace function public.kt_kitchen_reached_at(p_order_id uuid)
returns timestamptz language sql stable security definer set search_path = public as $$
  select min(h.created_at)
    from public.order_status_history h
   where h.order_id = p_order_id
     and h.status in ('Preparing', 'Out', 'Completed');
$$;

revoke all on function public.kt_kitchen_reached_at(uuid) from public, anon, authenticated;

/*
   Consumption per tracked product for one Lagos day. SUM(qty), never
   count(*): "Jollof x3" is three portions. Only tracked products, so the
   ledger and this agree on scope.
*/
create or replace function public.kt_inventory_consumption(p_from timestamptz, p_to timestamptz)
returns table (menu_item_id uuid, qty numeric)
language sql stable security definer set search_path = public as $$
  select oi.menu_item_id, sum(oi.qty)::numeric
    from public.order_items oi
    join public.orders o  on o.id = oi.order_id
    join public.menu_items mi on mi.id = oi.menu_item_id
   where mi.tracks_stock
     and public.kt_kitchen_reached_at(o.id) >= p_from
     and public.kt_kitchen_reached_at(o.id) <  p_to
   group by oi.menu_item_id;
$$;

revoke all on function public.kt_inventory_consumption(timestamptz, timestamptz)
  from public, anon, authenticated;

/* ---- 7. The daily picture ---------------------------------------------- */

/*
   One function, day-scoped, read-only, and the single definition of the
   inventory equation. admin_day_reports() consumes it rather than repeating
   any of this.

     opening      the newest physical count STRICTLY BEFORE this day. If none
                  exists it is NULL — never 0. "We have never counted this"
                  and "there were none" are different facts, and inventing
                  zero for the first would make every later variance wrong.
     expected     opening + prepared + adjustments - consumed - waste - meals.
                  NULL when opening is, because a closing cannot be computed
                  from an unknown opening. net_change is still reported, so
                  the day's activity is visible before a baseline exists.
     counted      the newest count recorded ON this day.
     variance     counted - expected. NULL unless both are known.

   Expected closing is NOT clamped at zero. A negative number means a
   preparation was not recorded, or something left without being written
   down, and hiding it would hide exactly the thing worth investigating.
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

  with tracked as (
    select id, name, sale_unit from public.menu_items where tracks_stock
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
  /* The newest count strictly before today, per product. */
  opening as (
    select distinct on (ic.menu_item_id) ic.menu_item_id, ic.qty, ic.business_date
      from public.inventory_counts ic
     where ic.business_date < v_date
     order by ic.menu_item_id, ic.business_date desc, ic.created_at desc
  ),
  /* The newest count recorded today, per product. */
  closing as (
    select distinct on (ic.menu_item_id) ic.menu_item_id, ic.qty, ic.created_at, ic.actor_id
      from public.inventory_counts ic
     where ic.business_date = v_date
     order by ic.menu_item_id, ic.created_at desc
  ),
  calc as (
    select t.id, t.name, t.sale_unit,
           o.qty                        as opening,
           o.business_date              as opening_from,
           coalesce(m.prepared, 0)      as prepared,
           coalesce(u.qty, 0)           as consumed,
           coalesce(m.waste, 0)         as waste,
           coalesce(m.staff_meal, 0)    as staff_meal,
           coalesce(m.adjustment, 0)    as adjustment,
           c.qty                        as counted,
           c.created_at                 as counted_at
      from tracked t
      left join moves   m on m.menu_item_id = t.id
      left join used    u on u.menu_item_id = t.id
      left join opening o on o.menu_item_id = t.id
      left join closing c on c.menu_item_id = t.id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'menu_item_id', id,
           'name',         name,
           'sale_unit',    sale_unit,
           'opening',      opening,
           'opening_from', opening_from,
           'opening_established', opening is not null,
           'prepared',     prepared,
           'consumed',     consumed,
           'waste',        waste,
           'staff_meal',   staff_meal,
           'adjustment',   adjustment,
           /* Always available, even with no baseline. */
           'net_change',   prepared + adjustment - consumed - waste - staff_meal,
           'expected_closing',
             case when opening is null then null
                  else opening + prepared + adjustment - consumed - waste - staff_meal end,
           'counted',      counted,
           'counted_at',   counted_at,
           'variance',
             case when opening is null or counted is null then null
                  else counted - (opening + prepared + adjustment - consumed - waste - staff_meal) end)
         order by sale_unit, name), '[]'::jsonb)
    into v_rows
    from calc;

  return jsonb_build_object(
    'business_date', v_date,
    'tracked',       true,
    'activated_on',  v_active,
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

/* ---- 8. Recording a movement ------------------------------------------- */

/*
   The only write path into the ledger. What it will not let happen:

     - a staff member writing an adjustment (kind is tier-checked here)
     - a negative prepared/waste/staff_meal (the CHECK constraint)
     - waste or an adjustment with no reason (the CHECK constraint)
     - a movement dated anything but today (business_date is computed here)
     - a movement against an untracked product
     - editing anything already recorded (there is no update path at all)
*/
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

  /* Adjustments move stock without anything physical having happened, which
     is why they sit a tier above the kinds that record real events. */
  if p_kind = 'adjustment' and not public.is_supervisor() then
    raise exception 'Adjustments are available to supervisors and above'
      using errcode = '42501';
  end if;

  if p_kind not in ('prepared', 'waste', 'staff_meal', 'adjustment') then
    raise exception 'Unknown movement kind: %', p_kind using errcode = '22023';
  end if;

  select name into v_name from public.menu_items
   where id = p_menu_item_id and tracks_stock;
  if v_name is null then
    raise exception 'That product is not stock-tracked' using errcode = '22023';
  end if;

  /* Server-side, always today. A caller cannot reach into a day whose
     variance has already been read. */
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

/* ---- 9. Recording a physical count ------------------------------------- */

/*
   Supervisor+, because a count is what every variance is measured against —
   it is the half of the equation nobody else can check. Counts are additive:
   recounting appends a new observation and the newest wins, so a correction
   here also leaves its predecessor visible.
*/
create or replace function public.inventory_count_record(
  p_menu_item_id uuid,
  p_qty          numeric,
  p_note         text default ''
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_date date;
  v_id   uuid;
  v_name text;
begin
  if not public.is_supervisor() then
    raise exception 'Physical counts are available to supervisors and above'
      using errcode = '42501';
  end if;
  if p_qty is null or p_qty < 0 then
    raise exception 'A count cannot be negative' using errcode = '22023';
  end if;

  select name into v_name from public.menu_items
   where id = p_menu_item_id and tracks_stock;
  if v_name is null then
    raise exception 'That product is not stock-tracked' using errcode = '22023';
  end if;

  v_date := (public.kt_today_start() at time zone 'Africa/Lagos')::date;

  insert into public.inventory_counts (menu_item_id, business_date, qty, note, actor_id)
  values (p_menu_item_id, v_date, p_qty, btrim(coalesce(p_note, '')), auth.uid())
  returning id into v_id;

  perform public.log_admin_action(
    'inventory.count', 'inventory_counts', v_id::text,
    v_name || ': counted ' || p_qty,
    jsonb_build_object('menu_item_id', p_menu_item_id, 'qty', p_qty,
                       'business_date', v_date));

  return jsonb_build_object('status', 'ok', 'id', v_id, 'business_date', v_date);
end;
$$;

revoke all on function public.inventory_count_record(uuid, numeric, text) from public, anon;
grant execute on function public.inventory_count_record(uuid, numeric, text) to authenticated;

/* ---- 10. History -------------------------------------------------------- */

/*
   What was recorded, by whom, and why — including corrections and what they
   corrected. Reads the ledger directly rather than admin_audit_log, which is
   owner-only: a supervisor needs to see the day's stock entries without
   anybody widening access to the audit trail.
*/
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
      select c.id, 'count', c.qty, null, c.note, c.created_at,
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

/* ---- 11. End-of-day integration ---------------------------------------- */

/*
   The manager's end-of-day screen gains an inventory block by CALLING the
   function above, not by repeating any of its arithmetic. One definition of
   the equation, two readers.
*/
create or replace function public.admin_day_reports(p_day date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_from  timestamptz;
  v_to    timestamptz;
  v_date  date;
  v_rows  jsonb;
  v_exp   integer := 0;
  v_sub   integer := 0;
  v_flag  integer := 0;
begin
  if not public.is_supervisor() then
    raise exception 'Supervisor access required' using errcode = '42501';
  end if;

  v_from := case when p_day is null then public.kt_today_start()
                 else (p_day::timestamp at time zone 'Africa/Lagos') end;
  v_to := v_from + interval '1 day';
  v_date := (v_from at time zone 'Africa/Lagos')::date;

  with worked as (
    select distinct h.created_by as staff_id
      from public.order_status_history h
     where h.created_by is not null
       and h.created_at >= v_from and h.created_at < v_to
  ),
  reported as (
    select r.staff_id from public.staff_day_reports r where r.business_date = v_date
  ),
  people as (
    select staff_id from worked union select staff_id from reported
  ),
  joined as (
    select pe.staff_id,
           nullif(btrim(coalesce(pr.display_name, '')), '') as name,
           pr.role,
           (pr.role in ('staff', 'supervisor'))             as expected,
           public.kt_staff_day_activity(pe.staff_id, v_from, v_to) as activity,
           r.id, r.status, r.submitted_at, r.reviewed_at, r.needs_follow_up,
           r.problems, r.customer_issues, r.stock_issues, r.follow_ups,
           r.notes, r.review_note, r.reviewed_by
      from people pe
      left join public.profiles pr on pr.id = pe.staff_id
      left join public.staff_day_reports r
             on r.staff_id = pe.staff_id and r.business_date = v_date
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'staff_id',        j.staff_id,
           'name',            j.name,
           'role',            j.role,
           'expected',        j.expected,
           'activity',        j.activity,
           'report', case when j.id is null then null else jsonb_build_object(
             'id',              j.id,
             'status',          j.status,
             'submitted_at',    j.submitted_at,
             'reviewed_at',     j.reviewed_at,
             'reviewed_by',     j.reviewed_by,
             'needs_follow_up', j.needs_follow_up,
             'problems',        j.problems,
             'customer_issues', j.customer_issues,
             'stock_issues',    j.stock_issues,
             'follow_ups',      j.follow_ups,
             'notes',           j.notes,
             'review_note',     j.review_note) end)
         order by (j.status = 'submitted') nulls first, j.name), '[]'::jsonb),
         count(*) filter (where j.expected),
         count(*) filter (where j.expected and j.status = 'submitted'),
         count(*) filter (where j.needs_follow_up)
    into v_rows, v_exp, v_sub, v_flag
    from joined j;

  return jsonb_build_object(
    'business_date', v_date,
    'generated_at',  now(),
    'viewer_role',   public.auth_role(),
    'team', jsonb_build_object(
      'expected',    v_exp,
      'submitted',   v_sub,
      'outstanding', greatest(0, v_exp - v_sub),
      'follow_up',   v_flag),
    /* Reused, not recomputed. */
    'operations', public.admin_order_activity(p_day) -> 'orders',
    'scoops',     public.admin_scoop_report(p_day),
    'inventory',  public.admin_inventory_day(p_day),
    'people',     v_rows);
end;
$$;

commit;
