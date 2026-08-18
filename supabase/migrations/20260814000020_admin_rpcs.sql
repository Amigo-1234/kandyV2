-- ---------------------------------------------------------------------------
-- Sensitive admin operations.
--
-- Money and roles never move through a table grant. Each function below is
-- SECURITY DEFINER, re-checks the caller's tier server-side, derives every
-- amount from stored state rather than trusting an argument, and writes an
-- audit row before returning.
--
-- The money tables keep NO client write policy of any kind, so these RPCs are
-- the only path that exists.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- admin_refund_order — admin + owner
--
-- The refund amount is NOT taken from the caller. It is the order's own total,
-- read under a row lock, so a manager cannot refund more than was paid.
-- ---------------------------------------------------------------------------
create or replace function public.admin_refund_order(
  p_order_code text,
  p_reason     text default ''
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_order   public.orders%rowtype;
  v_balance integer;
  v_ref     text;
begin
  if not public.is_manager() then
    raise exception 'Only an admin or owner may issue a refund' using errcode = '42501';
  end if;

  select * into v_order from public.orders where code = p_order_code for update;
  if not found then
    raise exception 'Order % not found', p_order_code using errcode = 'P0002';
  end if;
  if not v_order.paid then
    raise exception 'Order % is not paid and cannot be refunded', p_order_code using errcode = '22023';
  end if;
  if v_order.payment_status = 'refunded' then
    /* Idempotent: a second click is a no-op, not a second credit. */
    return jsonb_build_object('status', 'already_refunded', 'order_code', v_order.code);
  end if;

  v_ref := 'refund:' || v_order.code;

  update public.wallets
     set balance = balance + v_order.total, updated_at = now()
   where user_id = v_order.user_id
  returning balance into v_balance;

  if v_balance is null then
    raise exception 'No wallet for the customer on order %', p_order_code using errcode = 'P0002';
  end if;

  insert into public.wallet_transactions
    (user_id, type, reason, amount, balance_after, reference, order_id, description)
  values
    (v_order.user_id, 'credit', 'refund', v_order.total, v_balance, v_ref, v_order.id,
     'Refund for order ' || v_order.code)
  on conflict (reference) do nothing;

  update public.orders
     set payment_status = 'refunded', updated_at = now()
   where id = v_order.id;

  perform public.log_admin_action(
    'order.refund', 'orders', v_order.code,
    'Refunded ' || v_order.total || ' to wallet for order ' || v_order.code,
    jsonb_build_object('amount', v_order.total, 'reason', p_reason,
                       'customer', v_order.user_id));

  return jsonb_build_object('status', 'refunded', 'order_code', v_order.code,
                            'amount', v_order.total, 'balance_after', v_balance);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_adjust_wallet — OWNER ONLY
--
-- A manual correction. Deliberately the narrowest possible door: owner tier,
-- non-zero delta, cannot drive a balance negative, always audited.
-- ---------------------------------------------------------------------------
create or replace function public.admin_adjust_wallet(
  p_user_id uuid,
  p_delta   integer,
  p_reason  text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_balance integer;
begin
  if not public.is_owner() then
    raise exception 'Only the owner may adjust a wallet balance' using errcode = '42501';
  end if;
  if p_delta is null or p_delta = 0 then
    raise exception 'Adjustment amount must be non-zero' using errcode = '22023';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required for a manual adjustment' using errcode = '22023';
  end if;

  select balance into v_balance from public.wallets where user_id = p_user_id for update;
  if v_balance is null then
    raise exception 'No wallet for user %', p_user_id using errcode = 'P0002';
  end if;
  if v_balance + p_delta < 0 then
    raise exception 'Adjustment would take the balance below zero (% + %)', v_balance, p_delta
      using errcode = '22023';
  end if;

  update public.wallets
     set balance = balance + p_delta, updated_at = now()
   where user_id = p_user_id
  returning balance into v_balance;

  insert into public.wallet_transactions
    (user_id, type, reason, amount, balance_after, description)
  values
    (p_user_id,
     case when p_delta > 0 then 'credit' else 'debit' end,
     'adjustment', abs(p_delta), v_balance,
     'Manual adjustment: ' || p_reason);

  perform public.log_admin_action(
    'wallet.adjust', 'wallets', p_user_id::text,
    'Manual wallet adjustment of ' || p_delta,
    jsonb_build_object('delta', p_delta, 'reason', p_reason, 'balance_after', v_balance));

  return jsonb_build_object('status', 'adjusted', 'balance_after', v_balance);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_set_role — OWNER ONLY, with last-owner protection
--
-- The `role` column has no UPDATE grant for any client role, so this function
-- is the only way a role can change at all.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_role(
  p_user_id uuid,
  p_role    text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_old_role   text;
  v_owner_count integer;
begin
  if not public.is_owner() then
    raise exception 'Only the owner may change roles' using errcode = '42501';
  end if;
  if p_role not in ('customer', 'staff', 'admin', 'owner') then
    raise exception 'Unknown role: %', p_role using errcode = '22023';
  end if;

  select role into v_old_role from public.profiles where id = p_user_id for update;
  if v_old_role is null then
    raise exception 'No profile for user %', p_user_id using errcode = 'P0002';
  end if;
  if v_old_role = p_role then
    return jsonb_build_object('status', 'unchanged', 'role', p_role);
  end if;

  /* Last-owner protection: the project must never be left without an owner,
     which also makes it impossible for the final owner to demote themselves. */
  if v_old_role = 'owner' and p_role <> 'owner' then
    select count(*) into v_owner_count from public.profiles where role = 'owner';
    if v_owner_count <= 1 then
      raise exception 'Cannot remove the last owner. Promote another owner first.'
        using errcode = '42501';
    end if;
  end if;

  update public.profiles set role = p_role, updated_at = now() where id = p_user_id;

  perform public.log_admin_action(
    'role.change', 'profiles', p_user_id::text,
    'Role changed from ' || v_old_role || ' to ' || p_role,
    jsonb_build_object('from', v_old_role, 'to', p_role));

  return jsonb_build_object('status', 'updated', 'from', v_old_role, 'to', p_role);
end;
$$;

-- Callable by signed-in users; the tier check lives INSIDE each function.
revoke all on function public.admin_refund_order(text,text)          from public, anon;
revoke all on function public.admin_adjust_wallet(uuid,integer,text) from public, anon;
revoke all on function public.admin_set_role(uuid,text)              from public, anon;
grant execute on function public.admin_refund_order(text,text)          to authenticated, service_role;
grant execute on function public.admin_adjust_wallet(uuid,integer,text) to authenticated, service_role;
grant execute on function public.admin_set_role(uuid,text)              to authenticated, service_role;
