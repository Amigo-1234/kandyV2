/* ==========================================================================
   Paystack settlement — bind every payment to its order and its owner
   --------------------------------------------------------------------------
   Incident 27 Sep: Paystack was set to pass its transaction fee to the
   customer, so the signed charge (e.g. 928935 kobo) exceeded the order total
   (905000 kobo) and two genuine payments were refused as mismatches. The
   paystack-webhook function now settles such a payment against Paystack's
   signed requested_amount — but only after proving the extra is Paystack's
   own signed fee (see _shared/paystack.ts orderSettlementNaira).

   This migration adds the database half of that proof, so it holds whatever
   amount the caller passes: a successful payment settles an order only when

     - the reference is KT-<that order's code>-...  (as paystack-initialize
       generates it) and equals the reference inside the signed payload,
     - the signed metadata.order_code is that order, and
     - the signed metadata.user_id is that order's owner.

   Otherwise it is recorded as a 'mismatch' (reason 'binding') and refused.

   EVERYTHING ELSE IS UNCHANGED. settle_order_payment() is reproduced from
   0016 line for line — same signature, same grants, same idempotency (row
   lock, already-paid -> 'ignored', unique (provider, reference)), same
   failure branch, and the same exact `p_amount = orders.total` and NGN check,
   which stays the final authority on the amount. The one addition sits
   immediately before that amount check, on the success path only.

   No table, column, grant, trigger, wallet, pricing or other function
   changes.
   ========================================================================== */

begin;

create or replace function public.settle_order_payment(
  p_order_code     text,
  p_provider       text,
  p_reference      text,
  p_amount         integer,
  p_currency       text,
  p_gateway_status text,
  p_source         text,
  p_raw            jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
begin
  if p_reference is null or btrim(p_reference) = '' then
    raise exception 'payment reference is required' using errcode = '22023';
  end if;

  if p_provider is distinct from 'paystack' then
    raise exception 'unsupported payment provider: %', coalesce(p_provider,'(null)')
      using errcode = '22023';
  end if;

  select * into v_order from public.orders where code = p_order_code for update;

  if not found then
    raise exception 'order % not found', p_order_code using errcode = 'P0002';
  end if;

  if v_order.paid then
    insert into public.payment_events (order_id, provider, reference, amount,
                                       currency, status, source, raw)
    values (v_order.id, p_provider, p_reference, coalesce(p_amount,0),
            upper(coalesce(p_currency,'NGN')), 'ignored', p_source, p_raw)
    on conflict (provider, reference) do nothing;
    return jsonb_build_object('status','already_paid','order_code',v_order.code);
  end if;

  if coalesce(p_gateway_status,'') <> 'success' then
    insert into public.payment_events (order_id, provider, reference, amount,
                                       currency, status, source, raw)
    values (v_order.id, p_provider, p_reference, coalesce(p_amount,0),
            upper(coalesce(p_currency,'NGN')),
            case when p_gateway_status in ('cancelled','canceled') then 'cancelled'
                 else 'failed' end,
            p_source, p_raw)
    on conflict (provider, reference) do nothing;

    update public.orders
       set payment_status = case when p_gateway_status in ('cancelled','canceled')
                                 then 'cancelled' else 'failed' end,
           updated_at = now()
     where id = v_order.id;

    return jsonb_build_object('status','not_paid','order_code',v_order.code,
                              'gateway_status', p_gateway_status);
  end if;

  -- Binding (0079): a successful payment settles an order only if it was
  -- started FOR that order by that order's owner. paystack-initialize always
  -- generates the reference as KT-<order code>-<8 hex> and signs metadata
  -- {order_code, user_id}; anything else is recorded and refused, never
  -- settled. Compared as exact strings (no LIKE wildcards).
  if left(p_reference, length('KT-' || v_order.code || '-')) is distinct from ('KT-' || v_order.code || '-')
     or coalesce(p_raw -> 'data' ->> 'reference', '') is distinct from p_reference
     or coalesce(p_raw -> 'data' -> 'metadata' ->> 'order_code', '') is distinct from v_order.code
     or coalesce(p_raw -> 'data' -> 'metadata' ->> 'user_id', '') is distinct from v_order.user_id::text then
    insert into public.payment_events (order_id, provider, reference, amount,
                                       currency, status, source, raw)
    values (v_order.id, p_provider, p_reference, coalesce(p_amount,0),
            upper(coalesce(p_currency,'NGN')), 'mismatch', p_source, p_raw)
    on conflict (provider, reference) do nothing;

    return jsonb_build_object(
      'status','mismatch', 'reason','binding', 'order_code', v_order.code);
  end if;

  -- Amount / currency must match what the SERVER priced. Returns rather than
  -- raises, so the audit row below survives the transaction.
  if upper(coalesce(p_currency,'')) <> 'NGN'
     or p_amount is distinct from v_order.total then
    insert into public.payment_events (order_id, provider, reference, amount,
                                       currency, status, source, raw)
    values (v_order.id, p_provider, p_reference, coalesce(p_amount,0),
            upper(coalesce(p_currency,'NGN')), 'mismatch', p_source, p_raw)
    on conflict (provider, reference) do nothing;

    return jsonb_build_object(
      'status','mismatch', 'order_code', v_order.code,
      'expected', v_order.total, 'received', p_amount,
      'currency', upper(coalesce(p_currency,'')));
  end if;

  update public.orders
     set paid = true, payment_status = 'paid', payment_provider = p_provider,
         payment_ref = p_reference, updated_at = now()
   where id = v_order.id;

  insert into public.order_status_history (order_id, status, note)
  values (v_order.id, v_order.status,
          'Payment confirmed via ' || p_provider || ' (' || p_source || ').');

  insert into public.payment_events (order_id, provider, reference, amount,
                                     currency, status, source, raw)
  values (v_order.id, p_provider, p_reference, p_amount,
          upper(p_currency), 'success', p_source, p_raw)
  on conflict (provider, reference) do nothing;

  return jsonb_build_object('status','paid','order_code',v_order.code,'amount',p_amount);
end;
$$;


revoke all on function public.settle_order_payment(text,text,text,integer,text,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.settle_order_payment(text,text,text,integer,text,text,text,jsonb)
  to service_role;

commit;
