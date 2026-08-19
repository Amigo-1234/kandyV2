-- ---------------------------------------------------------------------------
-- Customer administration.
--
-- These are RPCs rather than table reads for two reasons that are not
-- negotiable in the schema as it stands:
--
--   1. Email lives in auth.users, which PostgREST does not expose. A join is
--      the only way to show it, and that join must be privileged.
--   2. The staff/admin split is a COLUMN-level rule ("staff may see a phone
--      number, not an email or a home address"). RLS gates rows, not columns,
--      so the redaction has to happen somewhere that can see the caller's
--      tier — here.
--
-- Every function re-checks the tier server-side. Being SECURITY DEFINER, they
-- would happily return everything to anyone; the guard at the top of each is
-- what stops that, not the caller's good manners.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- admin_list_customers — staff+ (redacted), admin+ (full)
--
-- Aggregates order counts in one pass rather than letting the client ask per
-- customer. Search and pagination are server-side so this still behaves with
-- a real customer base.
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_customers(
  p_search text default '',
  p_status text default 'all',
  p_limit  integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_manager boolean := public.is_manager();
  v_rows jsonb;
  v_total integer;
  v_term text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not public.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  with base as (
    select p.id, p.display_name, p.phone, p.role, p.created_at,
           u.email, u.last_sign_in_at,
           coalesce(o.n, 0)      as order_count,
           coalesce(o.spent, 0)  as total_spent,
           o.last_order_at
      from public.profiles p
      join auth.users u on u.id = p.id
      left join lateral (
        select count(*) n,
               sum(case when od.paid then od.total else 0 end) spent,
               max(od.created_at) last_order_at
          from public.orders od where od.user_id = p.id
      ) o on true
     where p.role = 'customer'
       and (v_term is null
            or p.display_name ilike '%' || v_term || '%'
            or u.email        ilike '%' || v_term || '%'
            or p.phone        ilike '%' || v_term || '%')
  ), classified as (
    select *,
           case when order_count = 0 then 'new'
                when last_order_at > now() - interval '90 days' then 'active'
                else 'dormant' end as status
      from base
  ), filtered as (
    select * from classified
     where p_status = 'all' or status = p_status
  )
  select count(*) into v_total from filtered;

  with base as (
    select p.id, p.display_name, p.phone, p.role, p.created_at,
           u.email, u.last_sign_in_at,
           coalesce(o.n, 0) as order_count,
           coalesce(o.spent, 0) as total_spent,
           o.last_order_at
      from public.profiles p
      join auth.users u on u.id = p.id
      left join lateral (
        select count(*) n,
               sum(case when od.paid then od.total else 0 end) spent,
               max(od.created_at) last_order_at
          from public.orders od where od.user_id = p.id
      ) o on true
     where p.role = 'customer'
       and (v_term is null
            or p.display_name ilike '%' || v_term || '%'
            or u.email        ilike '%' || v_term || '%'
            or p.phone        ilike '%' || v_term || '%')
  ), classified as (
    select *,
           case when order_count = 0 then 'new'
                when last_order_at > now() - interval '90 days' then 'active'
                else 'dormant' end as status
      from base
  )
  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.created_at desc), '[]'::jsonb)
    into v_rows
    from (
      select id, display_name, phone, created_at, order_count, status,
             /* Staff get what they need to serve an order and no more. */
             case when v_is_manager then email        else null end as email,
             case when v_is_manager then last_sign_in_at else null end as last_sign_in_at,
             case when v_is_manager then total_spent   else null end as total_spent
        from classified
       where p_status = 'all' or status = p_status
       order by created_at desc
       limit greatest(1, least(coalesce(p_limit, 50), 200))
      offset greatest(0, coalesce(p_offset, 0))
    ) x;

  return jsonb_build_object('rows', v_rows, 'total', v_total,
                            'tier', case when v_is_manager then 'manager' else 'staff' end);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_get_customer — the detail view.
--
-- Addresses are a home address: manager+ only. Opening a full record is an
-- act worth recording, so managers writing an audit row is deliberate.
-- ---------------------------------------------------------------------------
create or replace function public.admin_get_customer(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_manager boolean := public.is_manager();
  v_profile jsonb;
  v_orders jsonb;
  v_addresses jsonb := '[]'::jsonb;
  v_name text;
begin
  if not public.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  select to_jsonb(x) into v_profile from (
    select p.id, p.display_name, p.phone, p.created_at, p.role,
           case when v_is_manager then u.email else null end as email,
           case when v_is_manager then u.last_sign_in_at else null end as last_sign_in_at
      from public.profiles p join auth.users u on u.id = p.id
     where p.id = p_id and p.role = 'customer'
  ) x;

  if v_profile is null then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(to_jsonb(o) order by o.created_at desc), '[]'::jsonb)
    into v_orders
    from (
      select code, status, payment_status, paid, total, fulfilment, created_at
        from public.orders where user_id = p_id
       order by created_at desc limit 50
    ) o;

  if v_is_manager then
    select coalesce(jsonb_agg(to_jsonb(a) order by a.is_default desc), '[]'::jsonb)
      into v_addresses
      from (
        select label, recipient_name, phone, address, notes, is_default
          from public.addresses where user_id = p_id
      ) a;

    v_name := v_profile ->> 'display_name';
    perform public.log_admin_action(
      'customer.view_sensitive', 'profiles', p_id::text,
      'Viewed full customer record' ||
        case when v_name is null or v_name = '' then '' else ' for ' || v_name end,
      jsonb_build_object('tier', 'manager'));
  end if;

  return jsonb_build_object('profile', v_profile, 'orders', v_orders,
                            'addresses', v_addresses,
                            'tier', case when v_is_manager then 'manager' else 'staff' end);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_log_customer_export — manager+. The CSV is built in the browser from
-- data the caller already holds; this records that it happened.
-- ---------------------------------------------------------------------------
create or replace function public.admin_log_customer_export(p_count integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_manager() then
    raise exception 'Only an admin or owner may export customer data'
      using errcode = '42501';
  end if;
  perform public.log_admin_action(
    'customer.export', 'profiles', null,
    'Exported ' || coalesce(p_count, 0) || ' customer record(s)',
    jsonb_build_object('count', coalesce(p_count, 0)));
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_can_delete_customer — owner only. A read-only pre-flight so the UI can
-- explain WHY a deletion is impossible instead of surfacing a foreign-key
-- error after the fact.
--
-- orders.user_id is ON DELETE RESTRICT: a customer who has ever ordered
-- cannot be removed, which protects the order and accounting history.
-- ---------------------------------------------------------------------------
create or replace function public.admin_can_delete_customer(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_orders integer; v_addresses integer; v_wallet_tx integer; v_role text;
begin
  if not public.is_owner() then
    raise exception 'Only the owner may delete a customer' using errcode = '42501';
  end if;

  select role into v_role from public.profiles where id = p_id;
  if v_role is null then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
  if v_role <> 'customer' then
    return jsonb_build_object('can_delete', false,
      'reason', 'That account is a ' || v_role || ', not a customer. Change the role first.');
  end if;

  select count(*) into v_orders    from public.orders where user_id = p_id;
  select count(*) into v_addresses from public.addresses where user_id = p_id;
  select count(*) into v_wallet_tx from public.wallet_transactions where user_id = p_id;

  if v_orders > 0 then
    return jsonb_build_object('can_delete', false, 'orders', v_orders,
      'reason', 'This customer has ' || v_orders ||
                ' order(s). Order history is retained for accounting, so the ' ||
                'account cannot be deleted.');
  end if;

  return jsonb_build_object('can_delete', true, 'orders', 0,
    'addresses', v_addresses, 'wallet_transactions', v_wallet_tx);
end;
$$;

revoke all on function public.admin_list_customers(text,text,integer,integer) from public, anon;
revoke all on function public.admin_get_customer(uuid)                        from public, anon;
revoke all on function public.admin_log_customer_export(integer)              from public, anon;
revoke all on function public.admin_can_delete_customer(uuid)                 from public, anon;
grant execute on function public.admin_list_customers(text,text,integer,integer) to authenticated, service_role;
grant execute on function public.admin_get_customer(uuid)                        to authenticated, service_role;
grant execute on function public.admin_log_customer_export(integer)              to authenticated, service_role;
grant execute on function public.admin_can_delete_customer(uuid)                 to authenticated, service_role;
