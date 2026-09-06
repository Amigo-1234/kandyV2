/* ==========================================================================
   Phase 12 (Part 1) — takeaway grouping
   --------------------------------------------------------------------------
   A customer ordering for four people wants four bags, and the kitchen wants
   to know which dish goes in which. Until now there was nowhere to record
   that: order_items has no metadata column, and the basket collapsed two
   lines for the same dish into one before anything reached the server.

   GROUPING IS OPERATIONAL, NOT FINANCIAL
   --------------------------------------
   This is the whole safety argument and it is worth being blunt about.
   takeaway_group is customer-supplied presentation data. It is read once,
   clamped, and written to a column. It appears in NO price expression: not
   the subtotal, not the packaging fee, not delivery, not the coupon, not the
   total, not inventory. Packaging stays exactly what it was — one charge per
   order, ₦200 or ₦300 by the existing food rules — so an order costs the
   same whether it goes out in one bag or five. A hostile value cannot move
   a naira, because there is no arithmetic for it to reach.

   WHY THE COLUMN AND NOT A TRIGGER
   --------------------------------
   0049 added sale_unit with a BEFORE INSERT trigger and explicitly avoided
   editing this function. That worked because sale_unit is derivable from
   menu_items. A pack number is not derivable from anything — it originates
   with the customer — so it has to travel in the payload, and the function
   has to carry it. There is no way to do this without touching the 220-line
   checkout RPC, which is why this needed authorising rather than assuming.

   BACKWARD COMPATIBILITY
   ----------------------
   The column is nullable with no default. Every existing order_items row
   stays NULL and no historical order is rewritten, re-totalled or re-priced.
   A client that omits `group` behaves exactly as it did yesterday — which is
   every client until the matching frontend ships. NULL means "ungrouped",
   and both the customer and admin renderers fall back to their existing
   ungrouped output for it.

   ROLLBACK
   --------
     alter table public.order_items drop column takeaway_group;
   then re-apply the body of 20260814000013_checkout_rpc_fix.sql. No data is
   lost beyond the pack labels themselves.
   ========================================================================== */

begin;

/* ---- 1. Somewhere to put it -------------------------------------------- */

alter table public.order_items
  add column if not exists takeaway_group smallint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'order_items_takeaway_group_range'
       and conrelid = 'public.order_items'::regclass
  ) then
    alter table public.order_items
      add constraint order_items_takeaway_group_range
      check (takeaway_group is null or takeaway_group between 1 and 20);
  end if;
end $$;

comment on column public.order_items.takeaway_group is
  'Which physical takeaway pack this line belongs in, 1..20, or NULL for an '
  'ungrouped order. Presentation and kitchen routing only: it is written by '
  'create_checkout_order() after clamping and appears in no price, packaging, '
  'discount or inventory expression. Existing rows are NULL and are never '
  'backfilled.';

/* The kitchen reads an order grouped; without this the ordering is whatever
   the heap returns and pack 2 can print above pack 1. */
create index if not exists order_items_order_group_idx
  on public.order_items (order_id, takeaway_group nulls first);

/* ---- 2. Carry it through checkout -------------------------------------- */

/*
   This is 0013's function with three changes and nothing else:
     - _checkout_lines gains a takeaway_group column
     - the item loop reads, validates and clamps e.value ->> 'group'
     - the final insert carries the column

   Everything financial below is byte-identical to 0013: the same packaging
   regexes, the same delivery_fee lookup from app_settings, the same coupon
   validation, the same v_total arithmetic, the same idempotency behaviour.
*/
create or replace function public.create_checkout_order(
  p_items       jsonb,        -- [{ "menu_id": "...", "qty": 2, "group": 1 }, ...]
  p_fulfilment  text,
  p_address_id  uuid    default null,
  p_coupon_code text    default null,
  p_notes       text    default null,
  p_customer    jsonb   default '{}'::jsonb,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid            uuid := auth.uid();
  v_existing       public.orders%rowtype;
  v_order_id       uuid;
  v_code           text;
  v_subtotal       integer := 0;
  v_delivery_fee   integer := 0;
  v_takeaway_fee   integer := 0;
  v_discount       integer := 0;
  v_total          integer := 0;
  v_item_count     integer := 0;
  v_address        public.addresses%rowtype;
  v_snapshot       jsonb   := null;
  v_coupon         public.coupons%rowtype;
  v_code_in        text    := upper(nullif(btrim(coalesce(p_coupon_code, '')), ''));
  v_has_food       boolean := false;
  v_has_rice       boolean := false;
  v_has_beans      boolean := false;
  v_has_ofada      boolean := false;
  v_eta            integer;
  v_group          smallint;
  r                record;
begin
  ------------------------------------------------------------------ identity
  if v_uid is null then
    raise exception 'You must be signed in to place an order.'
      using errcode = '28000';
  end if;

  ------------------------------------------------------------- idempotency
  if p_idempotency_key is not null then
    select * into v_existing
      from public.orders
     where user_id = v_uid and idempotency_key = p_idempotency_key;
    if found then
      -- Same request arriving twice: hand back the order we already made.
      return jsonb_build_object(
        'orderId', v_existing.id, 'code', v_existing.code,
        'total', v_existing.total, 'duplicate', true);
    end if;
  end if;

  --------------------------------------------------------------- fulfilment
  if p_fulfilment is null or p_fulfilment not in ('delivery', 'pickup') then
    raise exception 'Choose delivery or pickup.' using errcode = '22023';
  end if;

  ------------------------------------------------------------------ address
  -- A delivery order must name an address, and that address must belong to
  -- the CALLER. This is the check that stops one customer shipping an order
  -- to (or billing it against) another customer's saved address.
  if p_fulfilment = 'delivery' then
    if p_address_id is null then
      raise exception 'Choose a delivery address first.' using errcode = '22023';
    end if;
    select * into v_address
      from public.addresses
     where id = p_address_id and user_id = v_uid;
    if not found then
      raise exception 'That delivery address could not be found.'
        using errcode = '42501';
    end if;
    v_snapshot := jsonb_build_object(
      'label', v_address.label, 'recipientName', v_address.recipient_name,
      'phone', v_address.phone, 'address', v_address.address,
      'notes', v_address.notes);
  end if;

  -------------------------------------------------------------------- items
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Your basket is empty.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 60 then
    raise exception 'That is too many different items for one order.'
      using errcode = '22023';
  end if;

  create temporary table if not exists _checkout_lines (
    menu_item_id uuid, name text, unit_price integer, qty integer,
    line_total integer, takeaway_group smallint
  ) on commit drop;
  -- A re-entrant call in the same transaction reuses the table, so make sure
  -- the new column exists even on the second pass through an old definition.
  alter table _checkout_lines add column if not exists takeaway_group smallint;
  -- Supabase blocks unqualified DELETE, and the temp table is ON COMMIT DROP
  -- anyway, so this is belt-and-braces for a re-entrant call in one txn.
  delete from _checkout_lines where true;

  for r in
    select
      nullif(e.value ->> 'menu_id', '')           as raw_id,
      coalesce((e.value ->> 'qty')::numeric, 0)   as raw_qty,
      e.value ->> 'group'                         as raw_group
    from jsonb_array_elements(p_items) e
  loop
    -- Quantity is validated, not trusted. Fractions and negatives are out.
    if r.raw_qty is null or r.raw_qty <> floor(r.raw_qty)
       or r.raw_qty < 1 or r.raw_qty > 50 then
      raise exception 'Quantity must be a whole number between 1 and 50.'
        using errcode = '22023';
    end if;

    /*
       The pack number. Absent, null, blank, non-numeric, fractional or out
       of range all resolve to NULL — an ungrouped line — rather than raising.
       This is deliberate and it is the one place the function is lenient:
       a bad pack label is a cosmetic problem, and refusing an otherwise
       valid, fully-paid-for basket over one would be the worse outcome. The
       value cannot do harm because it reaches no arithmetic; contrast the
       quantity above, which is money and therefore raises.
    */
    v_group := null;
    if r.raw_group is not null and btrim(r.raw_group) <> ''
       and r.raw_group ~ '^[0-9]{1,2}$' then
      v_group := r.raw_group::smallint;
      if v_group < 1 or v_group > 20 then
        v_group := null;
      end if;
    end if;

    -- The price comes from OUR row, never from the request. Accepts either a
    -- Supabase uuid or a legacy Firestore id, so a basket saved before the
    -- catalogue migration still checks out.
    insert into _checkout_lines
      (menu_item_id, name, unit_price, qty, line_total, takeaway_group)
    select m.id, m.name, m.price, r.raw_qty::integer, m.price * r.raw_qty::integer,
           v_group
      from public.menu_items m
     where (m.id::text = r.raw_id or m.legacy_firestore_id = r.raw_id)
       and m.status = 'available'
     limit 1;

    if not found then
      raise exception 'One of those dishes is no longer available.'
        using errcode = '22023';
    end if;
  end loop;

  select coalesce(sum(line_total), 0), coalesce(sum(qty), 0)
    into v_subtotal, v_item_count
    from _checkout_lines;

  if v_subtotal <= 0 then
    raise exception 'Your basket is empty.' using errcode = '22023';
  end if;

  --------------------------------------------------------------- packaging
  -- Mirrors KT.rules.takeawayFee / calculateTakeawayFee exactly: packaging is
  -- charged only when the order contains real food, and ofada (or rice with
  -- beans) needs the bigger pack.
  --
  -- ONCE PER ORDER, NOT ONCE PER PACK. Splitting an order into takeaway
  -- groups is a kitchen instruction, not a repricing event, and this
  -- aggregate deliberately ignores takeaway_group entirely.
  select
    bool_or(lower(name) !~ '(coke|fanta|pepsi|soda|juice|chivita|hollandia|yogurt|water)'
            and lower(name) ~ '(rice|beans|ofada|amala|swallow|semo|eba|spaghetti|pepper soup|pounded yam|ewa agoyin)'),
    bool_or(lower(name) !~ '(coke|fanta|pepsi|soda|juice|chivita|hollandia|yogurt|water)' and lower(name) like '%rice%'),
    bool_or(lower(name) !~ '(coke|fanta|pepsi|soda|juice|chivita|hollandia|yogurt|water)' and lower(name) like '%beans%'),
    bool_or(lower(name) !~ '(coke|fanta|pepsi|soda|juice|chivita|hollandia|yogurt|water)' and lower(name) like '%ofada%')
    into v_has_food, v_has_rice, v_has_beans, v_has_ofada
    from _checkout_lines;

  if coalesce(v_has_food, false) then
    v_takeaway_fee := case when coalesce(v_has_ofada,false)
                             or (coalesce(v_has_rice,false) and coalesce(v_has_beans,false))
                           then 300 else 200 end;
  end if;

  ---------------------------------------------------------------- delivery
  if p_fulfilment = 'delivery' and v_item_count > 0 then
    v_delivery_fee := coalesce(
      (select (value #>> '{}')::integer from public.app_settings where key = 'delivery_fee'), 500);
  end if;

  ------------------------------------------------------------------ coupon
  -- Validated against our own table: active, in date, and the basket must
  -- actually reach the minimum. A made-up code simply yields no discount.
  if v_code_in is not null then
    select * into v_coupon
      from public.coupons
     where code = v_code_in and active
       and (expires_at is null or expires_at > now());
    if found and v_subtotal >= v_coupon.min_subtotal then
      v_discount := case
        when v_coupon.type = 'percent' then round(v_subtotal * v_coupon.value / 100.0)
        when v_coupon.type = 'fixed'   then least(v_subtotal, v_coupon.value)
        else 0 end;
    else
      v_code_in := null;   -- do not record a coupon that was not applied
    end if;
  end if;

  ------------------------------------------------------------------- total
  v_total := v_subtotal + v_takeaway_fee + v_delivery_fee - v_discount;
  if v_total <= 0 then
    raise exception 'That order total is not valid.' using errcode = '22023';
  end if;

  v_eta := case when p_fulfilment = 'pickup' then 25 else 45 end;
  v_code := public.next_order_code();

  -------------------------------------------------------------- persistence
  insert into public.orders (
    user_id, code, status, payment_status, paid, fulfilment,
    address_id, address_snapshot, customer, notes,
    subtotal, delivery_fee, takeaway_fee, discount, vat, processing_fee,
    total, coupon_code, estimated_minutes, idempotency_key
  ) values (
    v_uid, v_code, 'New', 'pending', false, p_fulfilment,
    case when p_fulfilment = 'delivery' then p_address_id else null end,
    v_snapshot,
    coalesce(p_customer, '{}'::jsonb),
    left(coalesce(p_notes, ''), 500),
    v_subtotal, v_delivery_fee, v_takeaway_fee, v_discount, 0, 0,
    v_total, v_code_in, v_eta, p_idempotency_key
  )
  returning id into v_order_id;

  insert into public.order_items
    (order_id, menu_item_id, name, unit_price, qty, line_total, takeaway_group)
  select v_order_id, menu_item_id, name, unit_price, qty, line_total, takeaway_group
    from _checkout_lines;

  insert into public.order_status_history (order_id, status, note)
  values (v_order_id, 'New', 'Order received.');

  return jsonb_build_object(
    'orderId', v_order_id, 'code', v_code, 'total', v_total, 'duplicate', false);
end;
$$;

-- Only a signed-in customer may call it. anon and public cannot.
revoke all on function public.create_checkout_order(jsonb, text, uuid, text, text, jsonb, text) from public, anon;
grant execute on function public.create_checkout_order(jsonb, text, uuid, text, text, jsonb, text) to authenticated;

commit;
