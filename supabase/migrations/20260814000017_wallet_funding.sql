-- ---------------------------------------------------------------------------
-- Wallet funding & wallet-paid orders
--
-- Deliberately SEPARATE from settle_order_payment: different table, different
-- RPC, different reference namespace. A wallet top-up and an order payment can
-- never be confused for one another, and a bug in one cannot settle the other.
--
-- THE AMOUNT PROBLEM
-- An order carries its own authoritative total (orders.total), so settlement
-- can verify against it. A top-up has no such anchor — "credit me N naira" is
-- the customer's own request — so a webhook alone could credit any figure.
-- wallet_funding_intents fixes that: the Edge Function records the requested
-- amount server-side BEFORE the customer reaches Paystack, and settlement
-- verifies the gateway amount against that stored intent. The browser never
-- supplies an amount at settlement time.
-- ---------------------------------------------------------------------------

create table if not exists public.wallet_funding_intents (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  reference  text        not null unique check (btrim(reference) <> ''),
  amount     integer     not null check (amount > 0),
  currency   text        not null default 'NGN',
  status     text        not null default 'pending'
               check (status in ('pending','paid','failed','cancelled','mismatch')),
  raw        jsonb,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);

create index if not exists wallet_funding_intents_user_idx
  on public.wallet_funding_intents (user_id, created_at desc);

alter table public.wallet_funding_intents enable row level security;

-- The customer may SEE their own top-up attempts, never write one. Intents are
-- created exclusively by the Edge Function under service_role.
revoke all on public.wallet_funding_intents from anon, authenticated;
grant select on public.wallet_funding_intents to authenticated;

create policy wallet_funding_intents_select_own on public.wallet_funding_intents
  for select using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- settle_wallet_funding — the ONLY path that increases a balance
-- ---------------------------------------------------------------------------
create or replace function public.settle_wallet_funding(
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
  v_intent public.wallet_funding_intents%rowtype;
  v_balance integer;
begin
  if p_reference is null or btrim(p_reference) = '' then
    raise exception 'funding reference is required' using errcode = '22023';
  end if;

  if p_provider is distinct from 'paystack' then
    raise exception 'unsupported provider: %', coalesce(p_provider,'(null)')
      using errcode = '22023';
  end if;

  -- The intent is the authority for who is credited and how much.
  select * into v_intent
    from public.wallet_funding_intents
   where reference = p_reference
     for update;

  if not found then
    raise exception 'no funding intent for reference %', p_reference
      using errcode = 'P0002';
  end if;

  -- Idempotency: a replayed webhook finds the intent already settled.
  if v_intent.status = 'paid' then
    return jsonb_build_object('status','already_credited','reference',p_reference);
  end if;

  -- Never credit on a non-success status.
  if coalesce(p_gateway_status,'') <> 'success' then
    update public.wallet_funding_intents
       set status = case when p_gateway_status in ('cancelled','canceled')
                         then 'cancelled' else 'failed' end,
           raw = p_raw, settled_at = now()
     where id = v_intent.id;
    return jsonb_build_object('status','not_credited','gateway_status',p_gateway_status);
  end if;

  -- Amount and currency must match what was recorded BEFORE the customer paid.
  if upper(coalesce(p_currency,'')) <> upper(v_intent.currency)
     or p_amount is distinct from v_intent.amount then
    update public.wallet_funding_intents
       set status = 'mismatch', raw = p_raw, settled_at = now()
     where id = v_intent.id;
    return jsonb_build_object('status','mismatch','expected',v_intent.amount,
                              'received',p_amount,'currency',upper(coalesce(p_currency,'')));
  end if;

  -- Lock the wallet, then credit. The UNIQUE reference on wallet_transactions
  -- is the last line of defence against a double credit.
  select balance into v_balance from public.wallets
   where user_id = v_intent.user_id for update;

  if v_balance is null then
    insert into public.wallets (user_id) values (v_intent.user_id)
      on conflict (user_id) do nothing;
    v_balance := 0;
  end if;

  insert into public.wallet_transactions
    (user_id, type, reason, amount, balance_after, reference, description)
  values (v_intent.user_id, 'credit', 'funding', v_intent.amount,
          v_balance + v_intent.amount, p_provider || ':' || p_reference,
          'Wallet top-up via ' || p_provider)
  on conflict (reference) do nothing;

  if not found then
    -- Ledger row already existed: a concurrent settlement won the race.
    update public.wallet_funding_intents
       set status='paid', raw=p_raw, settled_at=now() where id=v_intent.id;
    return jsonb_build_object('status','already_credited','reference',p_reference);
  end if;

  update public.wallets
     set balance = balance + v_intent.amount, updated_at = now()
   where user_id = v_intent.user_id;

  update public.wallet_funding_intents
     set status = 'paid', raw = p_raw, settled_at = now()
   where id = v_intent.id;

  return jsonb_build_object('status','credited','amount',v_intent.amount,
                            'balance', v_balance + v_intent.amount);
end;
$$;

revoke all on function public.settle_wallet_funding(text,text,integer,text,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.settle_wallet_funding(text,text,integer,text,text,text,jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- pay_order_from_wallet — a DEBIT, initiated by the customer
--
-- Customer-callable (unlike the credit path) because the customer initiates
-- it, but every figure is read server-side: the amount is orders.total, never
-- a parameter. The caller supplies only an order code.
-- ---------------------------------------------------------------------------
create or replace function public.pay_order_from_wallet(p_order_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_order   public.orders%rowtype;
  v_balance integer;
begin
  if v_uid is null then
    raise exception 'sign in required' using errcode = '28000';
  end if;

  select * into v_order from public.orders
   where code = p_order_code and user_id = v_uid for update;

  if not found then
    raise exception 'order % not found', p_order_code using errcode = 'P0002';
  end if;

  if v_order.paid then
    return jsonb_build_object('status','already_paid','order_code',v_order.code);
  end if;

  select balance into v_balance from public.wallets where user_id = v_uid for update;
  v_balance := coalesce(v_balance, 0);

  if v_balance < v_order.total then
    return jsonb_build_object('status','insufficient_funds',
                              'balance',v_balance,'required',v_order.total);
  end if;

  insert into public.wallet_transactions
    (user_id, type, reason, amount, balance_after, reference, order_id, description)
  values (v_uid, 'debit', 'order_payment', v_order.total,
          v_balance - v_order.total, 'wallet:' || v_order.code, v_order.id,
          'Payment for order ' || v_order.code)
  on conflict (reference) do nothing;

  update public.wallets set balance = balance - v_order.total, updated_at = now()
   where user_id = v_uid;

  update public.orders
     set paid = true, payment_status = 'paid', payment_provider = 'wallet',
         payment_ref = 'wallet:' || v_order.code, updated_at = now()
   where id = v_order.id;

  insert into public.order_status_history (order_id, status, note)
  values (v_order.id, v_order.status, 'Paid from Kandy''s wallet.');

  return jsonb_build_object('status','paid','order_code',v_order.code,
                            'balance', v_balance - v_order.total);
end;
$$;

revoke all on function public.pay_order_from_wallet(text) from public, anon;
grant execute on function public.pay_order_from_wallet(text) to authenticated;

comment on function public.settle_wallet_funding is
  'Sole wallet-credit path. Verifies gateway amount against a pre-recorded intent. Idempotent. service_role only.';
comment on function public.pay_order_from_wallet is
  'Debits the caller''s wallet for their own order. Amount read from orders.total, never supplied.';
