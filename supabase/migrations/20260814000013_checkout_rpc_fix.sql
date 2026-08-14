-- ---------------------------------------------------------------------------
-- Fix: `delete from _checkout_lines;` had no WHERE clause, which Supabase
-- rejects ("DELETE requires a WHERE clause"). Every checkout aborted at that
-- statement, which also meant the item/quantity/coupon validations below it
-- were never reached. Replaces the function body only; no schema change.
-- ---------------------------------------------------------------------------

create or replace function public.create_checkout_order(
  p_items       jsonb,        -- [{ "menu_id": "...", "qty": 2 }, ...]
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
    menu_item_id uuid, name text, unit_price integer, qty integer, line_total integer
  ) on commit drop;
  -- Supabase blocks unqualified DELETE, and the temp table is ON COMMIT DROP
  -- anyway, so this is belt-and-braces for a re-entrant call in one txn.
  delete from _checkout_lines where true;

  for r in
    select
      nullif(e.value ->> 'menu_id', '')          as raw_id,
      coalesce((e.value ->> 'qty')::numeric, 0)  as raw_qty
    from jsonb_array_elements(p_items) e
  loop
    -- Quantity is validated, not trusted. Fractions and negatives are out.
    if r.raw_qty is null or r.raw_qty <> floor(r.raw_qty)
       or r.raw_qty < 1 or r.raw_qty > 50 then
      raise exception 'Quantity must be a whole number between 1 and 50.'
        using errcode = '22023';
    end if;

    -- The price comes from OUR row, never from the request. Accepts either a
    -- Supabase uuid or a legacy Firestore id, so a basket saved before the
    -- catalogue migration still checks out.
    insert into _checkout_lines (menu_item_id, name, unit_price, qty, line_total)
    select m.id, m.name, m.price, r.raw_qty::integer, m.price * r.raw_qty::integer
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

  insert into public.order_items (order_id, menu_item_id, name, unit_price, qty, line_total)
  select v_order_id, menu_item_id, name, unit_price, qty, line_total from _checkout_lines;

  insert into public.order_status_history (order_id, status, note)
  values (v_order_id, 'New', 'Order received.');

  return jsonb_build_object(
    'orderId', v_order_id, 'code', v_code, 'total', v_total, 'duplicate', false);
end;
$$;

-- Only a signed-in customer may call it. anon and public cannot.
revoke all on function public.create_checkout_order(jsonb, text, uuid, text, text, jsonb, text) from public, anon;
grant execute on function public.create_checkout_order(jsonb, text, uuid, text, text, jsonb, text) to authenticated;

revoke all on function public.next_order_code() from public, anon, authenticated;
