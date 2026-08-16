-- ---------------------------------------------------------------------------
-- Preserve the audit row when a gateway amount does not match the order.
--
-- The mismatch branch inserted into payment_events and then RAISE EXCEPTION'd.
-- Both ran in the same transaction, so the raise rolled the insert back: the
-- order correctly stayed unpaid, but the evidence of the attempt vanished —
-- precisely the case where you most want a record.
--
-- It now RETURNS a 'mismatch' result instead of raising, so the audit row
-- commits. The webhook already maps a non-settled result to HTTP 200 (the
-- payload is authentic and retrying cannot fix a wrong amount), so callers see
-- no behavioural change beyond the record now surviving.
-- ---------------------------------------------------------------------------

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
