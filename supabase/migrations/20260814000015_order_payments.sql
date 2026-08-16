-- ---------------------------------------------------------------------------
-- Order payments — Paystack
--
-- Settlement lives in the database, not in the Edge Function. The Edge
-- Function's only privileges are "can verify a signature" and "can call this
-- RPC"; every decision about whether an order becomes paid, and for how much,
-- is made here against server-held state.
--
-- The browser is never in this path. It cannot reach these objects at all:
-- `authenticated` holds no write grant on orders, and EXECUTE on the RPC is
-- granted exclusively to service_role.
-- ---------------------------------------------------------------------------

-- --------------------------------------------------------------------------
-- payment_events — the gateway audit trail
--
-- Deliberately NOT wallet_transactions: a card payment moves no wallet
-- balance, so writing it to the wallet ledger would make balance_after a lie.
-- The wallet ledger stays exclusively for wallet balance movements.
-- --------------------------------------------------------------------------
create table if not exists public.payment_events (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid references public.orders (id) on delete cascade,
  provider   text        not null check (provider in ('paystack')),
  reference  text        not null check (btrim(reference) <> ''),
  amount     integer     not null,
  currency   text        not null default 'NGN',
  status     text        not null
               check (status in ('success','failed','cancelled','mismatch','ignored')),
  source     text        not null check (source in ('webhook','callback')),
  raw        jsonb,
  created_at timestamptz not null default now(),
  -- One row per gateway transaction. This is what makes a replayed webhook a
  -- no-op at the audit layer; the order lock below is what makes it a no-op
  -- at the settlement layer.
  unique (provider, reference)
);

create index if not exists payment_events_order_idx on public.payment_events (order_id);

alter table public.payment_events enable row level security;

-- No customer-facing policy whatsoever. Even admins read this through the
-- server; a customer has no reason to see raw gateway payloads.
revoke all on public.payment_events from anon, authenticated;

create policy payment_events_admin_select on public.payment_events
  for select using (public.is_admin());

-- --------------------------------------------------------------------------
-- Tighten the wallet ledger: a money movement must carry an idempotency key.
-- `reference` was UNIQUE but nullable, and Postgres permits unlimited NULLs,
-- so uniqueness bought nothing for any row that omitted it. Only a manual
-- 'adjustment' (a human correction) may omit one.
-- Safe: wallet_transactions is empty.
-- --------------------------------------------------------------------------
alter table public.wallet_transactions
  drop constraint if exists wallet_transactions_reference_required;

alter table public.wallet_transactions
  add constraint wallet_transactions_reference_required
  check (reason = 'adjustment' or reference is not null);

-- --------------------------------------------------------------------------
-- settle_order_payment
--
-- The single settlement path. Both the webhook (authoritative) and the browser
-- callback (convenience) funnel through it, so they cannot disagree and
-- whichever arrives second is a no-op.
-- --------------------------------------------------------------------------
create or replace function public.settle_order_payment(
  p_order_code     text,
  p_provider       text,
  p_reference      text,
  p_amount         integer,   -- MAJOR units (naira), converted by the caller
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
  -- Reject a blank reference outright. V1 fell back to Date.now() here, which
  -- silently manufactured a fresh idempotency key on every retry.
  if p_reference is null or btrim(p_reference) = '' then
    raise exception 'payment reference is required'
      using errcode = '22023';
  end if;

  if p_provider is distinct from 'paystack' then
    raise exception 'unsupported payment provider: %', coalesce(p_provider,'(null)')
      using errcode = '22023';
  end if;

  -- FOR UPDATE serialises concurrent webhook + callback for the same order.
  select * into v_order from public.orders where code = p_order_code for update;

  if not found then
    raise exception 'order % not found', p_order_code using errcode = 'P0002';
  end if;

  -- Idempotency: whoever got here first already settled it.
  if v_order.paid then
    insert into public.payment_events (order_id, provider, reference, amount,
                                       currency, status, source, raw)
    values (v_order.id, p_provider, p_reference, coalesce(p_amount,0),
            upper(coalesce(p_currency,'NGN')), 'ignored', p_source, p_raw)
    on conflict (provider, reference) do nothing;

    return jsonb_build_object('status','already_paid','order_code',v_order.code);
  end if;

  -- A non-success gateway status never pays an order.
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

  -- Currency and amount must match what the SERVER computed for this order.
  -- p_amount comes from the gateway; v_order.total came from
  -- create_checkout_order, which priced every line from menu_items.
  if upper(coalesce(p_currency,'')) <> 'NGN'
     or p_amount is distinct from v_order.total then
    insert into public.payment_events (order_id, provider, reference, amount,
                                       currency, status, source, raw)
    values (v_order.id, p_provider, p_reference, coalesce(p_amount,0),
            upper(coalesce(p_currency,'NGN')), 'mismatch', p_source, p_raw)
    on conflict (provider, reference) do nothing;

    raise exception 'gateway amount % % does not match order % total %',
      p_amount, p_currency, v_order.code, v_order.total
      using errcode = '22023';
  end if;

  -- Settle.
  update public.orders
     set paid             = true,
         payment_status   = 'paid',
         payment_provider = p_provider,
         payment_ref      = p_reference,
         updated_at       = now()
   where id = v_order.id;

  insert into public.order_status_history (order_id, status, note)
  values (v_order.id, v_order.status,
          'Payment confirmed via ' || p_provider || ' (' || p_source || ').');

  insert into public.payment_events (order_id, provider, reference, amount,
                                     currency, status, source, raw)
  values (v_order.id, p_provider, p_reference, p_amount,
          upper(p_currency), 'success', p_source, p_raw)
  on conflict (provider, reference) do nothing;

  return jsonb_build_object('status','paid','order_code',v_order.code,
                            'amount', p_amount);
end;
$$;

-- The browser must never reach this. Only the service_role key, which lives
-- exclusively in Edge Function secrets, may execute it.
revoke all on function public.settle_order_payment(text,text,text,integer,text,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.settle_order_payment(text,text,text,integer,text,text,text,jsonb)
  to service_role;

comment on function public.settle_order_payment is
  'Sole settlement path for gateway payments. Idempotent, amount-verified against orders.total, service_role only.';
