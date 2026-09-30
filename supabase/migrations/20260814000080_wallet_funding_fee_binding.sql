/* ==========================================================================
   Wallet funding — accept Paystack's customer-borne fee, bind to the intent
   --------------------------------------------------------------------------
   Incident 30 Sep: Paystack passes its transaction fee to the customer, so a
   top-up of N naira is charged N + fee. paystack-webhook offered that gross
   charge to settle_wallet_funding(), whose exact check against the intent
   refused every card top-up as 'mismatch' and credited nothing — the same
   root cause as the 27 Sep order incident (0079).

   paystack-webhook now offers Paystack's signed requested_amount when the
   extra is provably Paystack's own fee (_shared/paystack.ts
   walletSettlementNaira). This migration adds the database half, so it holds
   whatever amount the caller passes. On the success path only, a top-up is
   credited only when

     - the reference is KTW-... and equals the reference inside the signed
       payload, metadata.purpose is wallet_funding and metadata.user_id is
       the intent's owner (reason 'binding' otherwise), and
     - the signed kobo figures prove the charge is the intent exactly, or the
       intent plus no more than Paystack's signed fee (reason 'amount').

   The credit is still v_intent.amount — the amount recorded before the
   customer paid — never the gross charge.

   EVERYTHING ELSE IS UNCHANGED. settle_wallet_funding() is reproduced from
   0017 line for line — same signature, same grants, same idempotency (intent
   row lock, 'paid' -> already_credited, UNIQUE wallet_transactions.reference
   'paystack:<ref>'), same failure branch, and the same exact
   `p_amount = intent.amount` and currency check, which stays the final
   authority. The two additions sit immediately before that check.

   No table, column, grant, trigger, order, pricing or other function changes.
   ========================================================================== */

begin;

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
  v_kobo    text;     -- signed data.amount (gross charge), kobo
  v_req     text;     -- signed data.requested_amount, kobo
  v_fees    text;     -- signed data.fees, kobo
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

  -- Binding (0080): a successful payment credits a wallet only if it was
  -- started FOR this intent by this intent's owner. wallet-fund-initialize
  -- always generates the reference as KTW-<18 hex> and signs metadata
  -- {purpose: 'wallet_funding', user_id}; anything else is recorded as a
  -- mismatch and never credited. Exact string comparisons (no LIKE).
  if left(p_reference, 4) is distinct from 'KTW-'
     or coalesce(p_raw -> 'data' ->> 'reference', '') is distinct from p_reference
     or coalesce(p_raw -> 'data' -> 'metadata' ->> 'purpose', '') is distinct from 'wallet_funding'
     or coalesce(p_raw -> 'data' -> 'metadata' ->> 'user_id', '') is distinct from v_intent.user_id::text then
    update public.wallet_funding_intents
       set status = 'mismatch', raw = p_raw, settled_at = now()
     where id = v_intent.id;
    return jsonb_build_object('status','mismatch','reason','binding','reference',p_reference);
  end if;

  -- Signed amount (0080), in exact kobo from the payload itself — never
  -- rebuilt from a rounded naira figure. Either Paystack charged exactly the
  -- intent, or it charged the intent plus its own signed fee (fees passed to
  -- the customer): requested_amount is exactly the intent, the charge is
  -- above it, and the extra is no more than the signed fee. Underpayments,
  -- arbitrary overpayments and any extra beyond the fee are refused.
  v_kobo := p_raw -> 'data' ->> 'amount';
  v_req  := p_raw -> 'data' ->> 'requested_amount';
  v_fees := p_raw -> 'data' ->> 'fees';
  if not (
       (coalesce(v_kobo, '') ~ '^[0-9]{1,15}$'
        and v_kobo::bigint = v_intent.amount::bigint * 100)
    or (coalesce(v_kobo, '') ~ '^[0-9]{1,15}$'
        and coalesce(v_req, '') ~ '^[0-9]{1,15}$'
        and coalesce(v_fees, '') ~ '^[0-9]{1,15}$'
        and v_req::bigint = v_intent.amount::bigint * 100
        and v_kobo::bigint > v_req::bigint
        and v_kobo::bigint - v_req::bigint <= v_fees::bigint)
  ) then
    update public.wallet_funding_intents
       set status = 'mismatch', raw = p_raw, settled_at = now()
     where id = v_intent.id;
    return jsonb_build_object('status','mismatch','reason','amount','expected',v_intent.amount,
                              'received',p_amount,'currency',upper(coalesce(p_currency,'')));
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

commit;
