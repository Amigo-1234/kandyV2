-- ---------------------------------------------------------------------------
-- Finance reporting — read-only, manager+.
--
-- Why RPCs rather than table reads:
--
--   payment_events.SELECT is is_owner(), decided in Phase 3 so that raw
--   gateway payloads stay with the owner. Finance needs an ADMIN to reconcile,
--   which would otherwise force loosening that policy. These functions return
--   the derived financial FACTS (amount, status, reference, mismatch reason)
--   and never the `raw` column, so an admin can reconcile without gaining
--   access to provider payloads.
--
-- Everything here is SELECT-only. No function writes to orders, payment_events,
-- wallets or wallet_transactions — reconciliation reports, it never repairs.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- admin_finance_overview — headline figures, manager+
--
-- Order value and collected value are returned SEPARATELY and never summed
-- together: an order total is what was asked for, a successful payment event
-- is what actually arrived, and conflating them is how a dashboard ends up
-- reporting revenue that was never collected.
-- ---------------------------------------------------------------------------
create or replace function public.admin_finance_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if not public.is_manager() then
    raise exception 'Finance is available to admins and the owner only'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'generated_at', now(),
    'orders', jsonb_build_object(
      'total',        (select count(*) from public.orders),
      'paid',         (select count(*) from public.orders where paid),
      'pending',      (select count(*) from public.orders where payment_status = 'pending'),
      'failed',       (select count(*) from public.orders where payment_status = 'failed'),
      'cancelled',    (select count(*) from public.orders where payment_status = 'cancelled'),
      'refunded',     (select count(*) from public.orders where payment_status = 'refunded')
    ),
    /* What was ASKED for. */
    'order_value', jsonb_build_object(
      'gross',        (select coalesce(sum(total), 0) from public.orders),
      'paid',         (select coalesce(sum(total), 0) from public.orders where paid),
      'outstanding',  (select coalesce(sum(total), 0) from public.orders
                        where not paid and payment_status = 'pending')
    ),
    /* What actually ARRIVED. Deliberately a different shape so the two can
       never be mistaken for one another. */
    'collected', jsonb_build_object(
      'events_success',   (select count(*) from public.payment_events where status = 'success'),
      'events_failed',    (select count(*) from public.payment_events where status = 'failed'),
      'events_cancelled', (select count(*) from public.payment_events where status = 'cancelled'),
      'events_mismatch',  (select count(*) from public.payment_events where status = 'mismatch'),
      'events_ignored',   (select count(*) from public.payment_events where status = 'ignored'),
      /* DISTINCT reference: a replayed webhook must not be counted twice. */
      'amount', (select coalesce(sum(amount), 0) from (
                   select distinct on (reference) amount
                     from public.payment_events where status = 'success'
                    order by reference, created_at) s)
    ),
    'wallets', jsonb_build_object(
      'count',            (select count(*) from public.wallets),
      'balance_total',    (select coalesce(sum(balance), 0) from public.wallets),
      'locked_total',     (select coalesce(sum(locked_balance), 0) from public.wallets),
      'transactions',     (select count(*) from public.wallet_transactions)
    ),
    'funding_intents', jsonb_build_object(
      'total',    (select count(*) from public.wallet_funding_intents),
      'pending',  (select count(*) from public.wallet_funding_intents where status = 'pending'),
      'paid',     (select count(*) from public.wallet_funding_intents where status = 'paid')
    )
  ) into v;

  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_reconciliation — DETECT and DISPLAY. It never repairs anything.
--
-- Each row is one finding with a machine-readable `issue` and a human
-- `detail`. An order in good standing produces no row.
-- ---------------------------------------------------------------------------
create or replace function public.admin_reconciliation(
  p_limit integer default 200
)
returns table (
  issue        text,
  severity     text,
  order_code   text,
  order_total  integer,
  event_ref    text,
  event_amount integer,
  event_status text,
  detail       text,
  occurred_at  timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_manager() then
    raise exception 'Finance is available to admins and the owner only'
      using errcode = '42501';
  end if;

  return query
  /* Paid, but nothing successful ever arrived. */
  select 'paid_without_event', 'critical', o.code, o.total, null::text, null::integer, null::text,
         'Order is marked paid but has no successful payment event.', o.updated_at
    from public.orders o
   where o.paid
     and not exists (select 1 from public.payment_events e
                      where e.order_id = o.id and e.status = 'success')

  union all
  /* Money arrived against an order that is not marked paid. */
  select 'event_without_paid', 'critical', o.code, o.total, e.reference, e.amount, e.status,
         'A successful payment event exists but the order is not marked paid.', e.created_at
    from public.payment_events e
    join public.orders o on o.id = e.order_id
   where e.status = 'success' and not o.paid

  union all
  /* Successful event with no order attached at all. */
  select 'orphan_event', 'critical', null::text, null::integer, e.reference, e.amount, e.status,
         'Successful payment event is not linked to any order.', e.created_at
    from public.payment_events e
   where e.status = 'success' and e.order_id is null

  union all
  /* Collected amount differs from the order total. */
  select 'amount_mismatch', 'critical', o.code, o.total, e.reference, e.amount, e.status,
         'Payment amount does not match the order total.', e.created_at
    from public.payment_events e
    join public.orders o on o.id = e.order_id
   where e.status = 'success' and e.amount is distinct from o.total

  union all
  /* The order points at a different reference than the one that succeeded. */
  select 'reference_mismatch', 'warning', o.code, o.total, e.reference, e.amount, e.status,
         'Order payment_ref does not match the successful event reference.', e.created_at
    from public.payment_events e
    join public.orders o on o.id = e.order_id
   where e.status = 'success'
     and o.payment_ref is not null
     and o.payment_ref is distinct from e.reference

  union all
  /* More than one successful event for the same order. */
  select 'duplicate_success', 'critical', o.code, o.total, min(e.reference), sum(e.amount)::integer, 'success',
         'Order has ' || count(*) || ' successful payment events.', max(e.created_at)
    from public.payment_events e
    join public.orders o on o.id = e.order_id
   where e.status = 'success'
   group by o.code, o.total
  having count(*) > 1

  union all
  /* Gateway rejected an amount — recorded, never settled. Worth a look. */
  select 'amount_rejected', 'warning', o.code, o.total, e.reference, e.amount, e.status,
         'A payment was refused because the amount did not match.', e.created_at
    from public.payment_events e
    join public.orders o on o.id = e.order_id
   where e.status = 'mismatch'

  union all
  /* A wallet top-up that was started and never completed. */
  select 'funding_never_settled', 'info', null::text, null::integer, i.reference, i.amount, i.status,
         'Wallet funding intent is still pending and was never settled.', i.created_at
    from public.wallet_funding_intents i
   where i.status = 'pending'

  order by 2, 9 desc
  limit greatest(1, least(coalesce(p_limit, 200), 500));
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_payment_events — the event list WITHOUT `raw`.
-- Manager+ may audit the money; the provider payload stays owner-only.
-- ---------------------------------------------------------------------------
create or replace function public.admin_payment_events(
  p_search text default '',
  p_status text default 'all',
  p_limit  integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_total integer;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not public.is_manager() then
    raise exception 'Finance is available to admins and the owner only'
      using errcode = '42501';
  end if;

  select count(*) into v_total
    from public.payment_events e
    left join public.orders o on o.id = e.order_id
   where (p_status = 'all' or e.status = p_status)
     and (v_search is null
          or e.reference ilike '%' || v_search || '%'
          or o.code ilike '%' || v_search || '%');

  select coalesce(jsonb_agg(r order by r->>'created_at' desc), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
               'id', e.id, 'reference', e.reference, 'provider', e.provider,
               'amount', e.amount, 'currency', e.currency, 'status', e.status,
               'source', e.source, 'created_at', e.created_at,
               'order_code', o.code, 'order_total', o.total,
               'order_paid', o.paid, 'order_payment_status', o.payment_status
             ) r
        from public.payment_events e
        left join public.orders o on o.id = e.order_id
       where (p_status = 'all' or e.status = p_status)
         and (v_search is null
              or e.reference ilike '%' || v_search || '%'
              or o.code ilike '%' || v_search || '%')
       order by e.created_at desc
       limit greatest(1, least(coalesce(p_limit, 50), 200))
      offset greatest(0, coalesce(p_offset, 0))
    ) s;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

revoke all on function public.admin_finance_overview()                  from public, anon;
revoke all on function public.admin_reconciliation(integer)             from public, anon;
revoke all on function public.admin_payment_events(text,text,integer,integer) from public, anon;
grant execute on function public.admin_finance_overview()               to authenticated, service_role;
grant execute on function public.admin_reconciliation(integer)          to authenticated, service_role;
grant execute on function public.admin_payment_events(text,text,integer,integer) to authenticated, service_role;

comment on function public.admin_reconciliation is
  'Read-only. Reports payment/order mismatches; never modifies anything.';
