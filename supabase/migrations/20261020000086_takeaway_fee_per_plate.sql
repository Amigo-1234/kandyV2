/* ==========================================================================
   0086 — Takeaway packaging charged per plate
   --------------------------------------------------------------------------
   THE PROBLEM

   create_checkout_order() (last defined in 0071) charged packaging ONCE PER
   ORDER: one bool_or() over the whole basket decided "is there food?", and
   the order paid ₦200 or ₦300 once — however many plates went out. The
   basket (KT.rules.takeawayFee) mirrored the same rule and the cart said so.
   It also classified dishes by regex on the name, so "Poundo with efo riro"
   and "Poundo with Egusi soup" were never charged, White Rice paid the ₦200
   rate, and the owner's takeaway_fee setting was never read.

   THE RULE (approved 2026-10-20)

     Rates: the takeaway_fee setting — standard ₦200, combined ₦300.

     Dishes sold by the scoop or cup (rice, spaghetti, beans) are portions:
     everything of that kind in ONE takeaway pack is ONE plate. An ungrouped
     basket is one pack; each extra pack the customer opens is another plate.
     A plate is ₦300 when its pack holds White Rice or Ofada, or any rice
     together with beans; otherwise ₦200.

     Dishes sold as a whole plate or bowl (Ewa Agoyin, Pounded Yam / Poundo /
     Semo meals, Catfish Pepper Soup) are one plate PER UNIT at ₦200.

     Everything without a packaging class pays nothing, as today: drinks,
     proteins, shawarma, chicken & chips boxes, specials, bread, salad,
     plantain, ketchup.

       2 packs of White Rice                 ₦600
       3 packs of Ofada                      ₦900
       2 Ewa Agoyin plates                   ₦400
       2 packs of White Rice + 1 Ewa Agoyin  ₦800

   CLASSIFICATION, NOT NAMES

   menu_items.pack_class (0001) gains two values and four products are
   (re)classified, each matched by its exact current name and asserted to
   exist exactly once:

     'large'     White Rice (per scoop)          (was 'standard')
     'rice'      Jollof Rice, Fried Rice          (was 'standard')
     'standard'  Poundo with Egusi soup           (was NULL)

   'ofada', 'beans' and every other 'standard' row are unchanged. pack_class
   becomes a manager-only field, like sale_unit, and editable in Menu
   management so a new dish can be classified without a migration.

   NOTHING HISTORICAL CHANGES

   No order, order line, payment, wallet transaction or commission is
   touched. orders.takeaway_fee and orders.total of every existing order stay
   exactly as charged; only orders created after this migration use the new
   rule. Payment (Paystack and wallet), receipts, admin order detail and
   finance all read orders.takeaway_fee / orders.total, which the server
   computes here — nothing else needs to change for them to be correct.

   Everything else in create_checkout_order() is byte-identical to 0071:
   validation, prices, delivery fee, coupon, total arithmetic, idempotency,
   takeaway_group clamping.
   ========================================================================== */

begin;

/* ---- 1. Two more packaging classes -------------------------------------- */

alter table public.menu_items drop constraint if exists menu_items_pack_class_check;
alter table public.menu_items
  add constraint menu_items_pack_class_check
  check (pack_class in ('standard', 'rice', 'large', 'ofada', 'beans'));

comment on column public.menu_items.pack_class is
  'Takeaway packaging (0086). NULL: none. Scoop/cup dishes make one plate per '
  'takeaway pack — ₦300 if the pack has large (White Rice) or ofada, or any '
  'rice (rice/large/ofada) with beans, else ₦200. Unit dishes: one plate per '
  'unit — ₦300 for large/ofada, else ₦200. Rates from app_settings.takeaway_fee.';

/* ---- 2. Reclassify the four products ------------------------------------ */

do $$
declare
  r record;
  n integer;
begin
  for r in
    select * from (values
      ('White Rice (per scoop)',  'large'),
      ('Jollof Rice (per scoop)', 'rice'),
      ('Fried Rice (per scoop)',  'rice'),
      ('Poundo with Egusi soup',  'standard')
    ) v(name, cls)
  loop
    select count(*) into n from public.menu_items
     where name = r.name and deleted_at is null;
    if n <> 1 then
      raise exception '0086: expected exactly one live menu item named %, found %', r.name, n;
    end if;
    update public.menu_items set pack_class = r.cls
     where name = r.name and deleted_at is null
       and pack_class is distinct from r.cls;
  end loop;
end $$;

/* ---- 3. Managers classify; staff cannot ---------------------------------- */

grant update (pack_class) on public.menu_items to authenticated;

/* As 0054, with pack_class added to the fields staff may not change. */
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
     or new.tracks_stock is distinct from old.tracks_stock
     or new.pack_class  is distinct from old.pack_class then
    raise exception 'Staff may only change item availability'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

/* ---- 4. Checkout prices packaging per plate ------------------------------ */

/* 0071's function; changes: _checkout_lines carries pack_class and
   sale_unit from the menu row, and the packaging block below. */
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
  v_pack_std       integer;
  v_pack_big       integer;
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
    line_total integer, takeaway_group smallint,
    pack_class text, sale_unit text
  ) on commit drop;
  -- A re-entrant call in the same transaction reuses the table, so make sure
  -- the new columns exist even on the second pass through an old definition.
  alter table _checkout_lines add column if not exists takeaway_group smallint;
  alter table _checkout_lines add column if not exists pack_class text;
  alter table _checkout_lines add column if not exists sale_unit text;
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
      (menu_item_id, name, unit_price, qty, line_total, takeaway_group,
       pack_class, sale_unit)
    select m.id, m.name, m.price, r.raw_qty::integer, m.price * r.raw_qty::integer,
           v_group, m.pack_class, m.sale_unit
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
  -- Per plate (0086). Classification comes from OUR menu row — pack_class
  -- and sale_unit — never from the dish name and never from the request.
  --
  --   pack_class NULL         no packaging (drinks, proteins, shawarma,
  --                           chicken & chips boxes, specials, sides...)
  --   sold by scoop or cup    portions that make up ONE plate per takeaway
  --                           pack (an ungrouped basket is one pack). The
  --                           plate is the bigger rate when the pack holds
  --                           White Rice or Ofada ('large'/'ofada'), or any
  --                           rice together with beans; otherwise standard.
  --   sold as a unit          a whole plate/bowl (Ewa Agoyin, swallow meals,
  --                           pepper soup): one plate PER UNIT.
  --
  -- Rates are the owner's takeaway_fee setting (standard / combined),
  -- defaulting to 200 / 300. takeaway_group is still only a pack number: it
  -- decides how many plates there are, never what any dish costs.
  select coalesce((value ->> 'standard')::integer, 200),
         coalesce((value ->> 'combined')::integer, 300)
    into v_pack_std, v_pack_big
    from public.app_settings where key = 'takeaway_fee';
  v_pack_std := coalesce(v_pack_std, 200);
  v_pack_big := coalesce(v_pack_big, 300);

  select coalesce(sum(case when p.big then v_pack_big else v_pack_std end), 0)
    into v_takeaway_fee
    from (
      select bool_or(l.pack_class in ('large', 'ofada'))
             or (bool_or(l.pack_class in ('rice', 'large', 'ofada'))
                 and bool_or(l.pack_class = 'beans')) as big
        from _checkout_lines l
       where l.pack_class is not null and l.sale_unit in ('scoop', 'cup')
       group by coalesce(l.takeaway_group, 0)
    ) p;

  v_takeaway_fee := v_takeaway_fee + coalesce((
    select sum(l.qty * case when l.pack_class in ('large', 'ofada')
                            then v_pack_big else v_pack_std end)
      from _checkout_lines l
     where l.pack_class is not null
       and coalesce(l.sale_unit, 'unit') not in ('scoop', 'cup')), 0);

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
