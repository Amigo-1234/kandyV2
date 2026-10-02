-- Proposed only. Existing accounts remain normal; no partner rows are seeded.
begin;
create table public.referral_code_aliases (
 code text primary key check (code = upper(code) and code ~ '^[A-Z0-9]{4,20}$'),
 user_id uuid references public.profiles(id) on delete set null
);
alter table public.referral_code_aliases enable row level security;
revoke all on public.referral_code_aliases from anon, authenticated;
insert into public.referral_code_aliases(code,user_id) select upper(code),user_id from public.referral_codes;
create table public.partner_referrers (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 enabled boolean not null default false
);
alter table public.partner_referrers enable row level security;
revoke all on public.partner_referrers from anon, authenticated;
alter table public.referrals add column code_used text,
 add column partner_reward boolean not null default false,
 add column commission_base integer,
 add column commission_amount integer,
 add column commission_transaction_id uuid references public.wallet_transactions(id);

-- Reserve every current and former code atomically, including generated codes.
create function public.reserve_referral_code() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_owner uuid;
begin
 new.code := upper(btrim(new.code));
 if new.code !~ '^[A-Z0-9]{4,20}$' then raise exception 'Use 4–20 letters or numbers' using errcode='22023'; end if;
 insert into public.referral_code_aliases(code,user_id) values(new.code,new.user_id)
 on conflict(code) do nothing;
 select user_id into v_owner from public.referral_code_aliases where code=new.code;
 if v_owner is distinct from new.user_id then raise exception 'Code already reserved' using errcode='23505'; end if;
 return new;
end $$;
revoke all on function public.reserve_referral_code() from public,anon,authenticated;
create trigger reserve_referral_code before insert or update on public.referral_codes
 for each row execute function public.reserve_referral_code();
create or replace function public.generate_referral_code()
returns text language plpgsql security definer set search_path = public as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text;
  v_try  integer := 0;
begin
  loop
    v_code := 'KANDY';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.referral_code_aliases where code = v_code);
    v_try := v_try + 1;
    if v_try > 20 then
      raise exception 'Could not allocate a referral code' using errcode = '55000';
    end if;
  end loop;
  return v_code;
end;
$$;
create function public.customize_referral_code(p_code text) returns text
language plpgsql security definer set search_path=public as $$
declare v_code text;
begin
 if auth.uid() is null then raise exception 'Sign in required' using errcode='28000'; end if;
 perform public.my_referral_code();
 update public.referral_codes set code=p_code where user_id=auth.uid() returning code into v_code;
 return v_code;
end $$;
revoke all on function public.customize_referral_code(text) from public,anon;
grant execute on function public.customize_referral_code(text) to authenticated;
create function public.admin_set_partner_referrer(p_user_id uuid,p_enabled boolean,p_code text default null)
returns void language plpgsql security definer set search_path=public as $$
begin
 if not public.is_manager() then raise exception 'Admin or owner required' using errcode='42501'; end if;
 -- Lock account so concurrent administration cannot race signup attribution.
 perform 1 from public.profiles where id=p_user_id for update;
 if not found then raise exception 'User not found'; end if;
 if p_code is not null then
 insert into public.referral_codes(user_id,code) values(p_user_id,p_code)
 on conflict(user_id) do update set code=excluded.code;
 end if;
 insert into public.partner_referrers(user_id,enabled) values(p_user_id,p_enabled)
 on conflict(user_id) do update set enabled=excluded.enabled;
end $$;
revoke all on function public.admin_set_partner_referrer(uuid,boolean,text) from public,anon;
grant execute on function public.admin_set_partner_referrer(uuid,boolean,text) to authenticated;
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code     text;
  v_referrer uuid;
  v_partner boolean;
begin
  insert into public.profiles (id, display_name, phone, photo_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name',
             new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.raw_user_meta_data ->> 'phone', ''),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', '')
  )
  on conflict (id) do nothing;

  insert into public.wallets (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  begin
    v_code := upper(btrim(coalesce(new.raw_user_meta_data ->> 'referral_code', '')));
    if v_code <> '' then
      select a.user_id, exists (
        select 1 from public.partner_referrers p
         where p.user_id=a.user_id and p.enabled
      ) into v_referrer, v_partner
        from public.referral_code_aliases a where a.code = v_code;

      /* A real code, belonging to somebody else. Self-referral fails here on
         the id comparison and again on referrals_not_self. */
      if v_referrer is not null and v_referrer <> new.id then
        insert into public.referrals (referrer_id, referred_id, status, code_used, partner_reward)
        values (v_referrer, new.id, 'signed_up', v_code, coalesce(v_partner,false))
        on conflict do nothing;   /* one_referrer index decides */
      end if;
    end if;
  exception when others then
    /* Attribution is best-effort. Signup is not. */
    raise warning 'referral attribution skipped for %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;
create or replace function public.referral_qualify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_ref        public.referrals%rowtype;
  v_min        integer;
  v_partner boolean;
  v_commission integer;
  v_balance integer;
  v_tx uuid;
  v_pts_ref    integer;
  v_pts_new    integer;
  v_expiry     integer;
  v_expires_at timestamptz;
  v_earlier    integer;
begin
  /*
     Only the transition into a completed, paid order is interesting — and
     not one that has already been refunded. admin_refund_order() sets
     payment_status='refunded' while leaving paid and status alone (Completed
     is a terminal state and cannot be moved), so without this an order that
     had already been given back could still mint points on a later touch.
  */
  if not (new.paid and new.status = 'Completed') then return new; end if;
  if new.payment_status = 'refunded' then return new; end if;
  if old.paid = new.paid and old.status is not distinct from new.status then return new; end if;

  select * into v_ref from public.referrals
   where referred_id = new.user_id and status = 'signed_up'
   for update;
  if not found then return new; end if;

  v_min := public.reward_setting('referral_min_order', 2500);
  if new.total < v_min then return new; end if;

  /* FIRST qualifying order only. An earlier one that already met the bar
     means this customer's referral window has closed. */
  select count(*) into v_earlier
    from public.orders o
   where o.user_id = new.user_id
     and o.id <> new.id
     and o.paid
     and o.status = 'Completed'
     and o.total >= v_min
     and o.created_at < new.created_at;
  if v_earlier > 0 then return new; end if;

  if v_ref.partner_reward then
    -- The mode is snapshotted at attribution. The server-priced subtotal less
    -- the server-priced discount excludes delivery, packaging, VAT and fees.
    v_commission := floor(greatest(0, new.subtotal - new.discount)::numeric * 0.10)::integer;
    if v_commission > 0 then
      select balance into v_balance from public.wallets
        where user_id=v_ref.referrer_id and status='active' for update;
      if not found then raise exception 'Partner wallet is not active'; end if;
      insert into public.wallet_transactions
        (user_id,type,reason,amount,balance_after,reference,order_id,description)
      values(v_ref.referrer_id,'credit','reward',v_commission,v_balance+v_commission,
        'partner-referral:' || new.id::text,new.id,'Celebrity / Partner referral commission')
      returning id into v_tx;
    end if;
    update public.referrals set status='rewarded',qualifying_order_id=new.id,
      qualified_at=now(),rewarded_at=now(),
      commission_base=greatest(0,new.subtotal-new.discount),commission_amount=v_commission,
      commission_transaction_id=v_tx
      where id=v_ref.id;
    return new; -- Neither side receives the ordinary points reward.
  end if;

  v_pts_ref := public.reward_setting('referral_referrer_points', 100);
  v_pts_new := public.reward_setting('referral_referred_points', 100);
  v_expiry  := public.reward_setting('referral_points_expiry_days', 90);
  v_expires_at := now() + make_interval(days => greatest(1, v_expiry));

  update public.referrals
     set status = 'rewarded',
         qualifying_order_id = new.id,
         qualified_at = now(),
         rewarded_at  = now()
   where id = v_ref.id;

  if v_ref.referrer_id is not null and v_pts_ref > 0 then
    insert into public.reward_points
      (user_id, kind, points, points_remaining, expires_at, source, referral_id)
    values (v_ref.referrer_id, 'earn', v_pts_ref, v_pts_ref, v_expires_at,
            'referral_referrer', v_ref.id);

    perform public.notify_user(
      v_ref.referrer_id, 'reward', 'Your referral reward has been earned',
      'A friend you invited placed their first order. You have earned '
        || v_pts_ref || ' Kandy Rewards points.',
      null, false);
  end if;

  if v_pts_new > 0 then
    insert into public.reward_points
      (user_id, kind, points, points_remaining, expires_at, source, referral_id)
    values (new.user_id, 'earn', v_pts_new, v_pts_new, v_expires_at,
            'referral_referred', v_ref.id);

    perform public.notify_user(
      new.user_id, 'reward', 'You have earned Kandy Rewards points',
      'Thanks for your first order. You have earned ' || v_pts_new
        || ' Kandy Rewards points.',
      null, false);
  end if;

  return new;

exception when others then
  /*
     THE ORDER QUEUE OUTRANKS THE REWARD. This trigger sits on the live
     orders table; if it raised, a handler could not move an order to
     Completed and the kitchen would stall. The same reasoning dispatch_push()
     uses for notifications applies with more force to money: a missed
     referral reward can be reconciled afterwards from the referrals row,
     a shift that cannot close its orders cannot.

     The warning is logged rather than swallowed silently, and because the
     referral stays 'signed_up' the next qualifying transition will simply
     try again.
  */
  raise warning 'referral qualification skipped for order %: %', new.id, sqlerrm;
  return new;
end;
$$;
-- Ledger-driven wallet projection, restricted to this reward reference namespace.
-- Qualification inserts a ledger entry; it never directly changes a balance.
create function public.apply_partner_referral_credit() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if new.reference like 'partner-referral:%' and new.type='credit' and new.reason='reward' then
   update public.wallets set balance=new.balance_after,updated_at=now() where user_id=new.user_id;
 end if;
 return new;
end $$;
revoke all on function public.apply_partner_referral_credit() from public,anon,authenticated;
create trigger apply_partner_referral_credit after insert on public.wallet_transactions
 for each row execute function public.apply_partner_referral_credit();
create function public.admin_partner_referrals() returns jsonb
language plpgsql security definer set search_path=public as $$
begin
 if not public.is_manager() then raise exception 'Admin or owner required' using errcode='42501'; end if;
 return jsonb_build_object(
 'users',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.display_name,
 'enabled',coalesce(pr.enabled,false),'code',c.code,'aliases',coalesce((
   select jsonb_agg(a.code order by a.code) from public.referral_code_aliases a
   where a.user_id=p.id and (c.code is null or a.code<>c.code)
 ),'[]'::jsonb))),'[]') from public.profiles p
 left join public.partner_referrers pr on pr.user_id=p.id left join public.referral_codes c on c.user_id=p.id),
 'referrals',(select coalesce(jsonb_agg(jsonb_build_object('referrer_id',r.referrer_id,
 'customer_id',r.referred_id,'customer_name',p.display_name,'code_used',r.code_used,
 'order_id',r.qualifying_order_id,'base',r.commission_base,'commission',r.commission_amount,
 'credited',r.commission_transaction_id is not null,'partner_reward',r.partner_reward)),'[]')
 from public.referrals r join public.profiles p on p.id=r.referred_id
 where r.partner_reward or exists(select 1 from public.partner_referrers pr where pr.user_id=r.referrer_id)));
end $$;
revoke all on function public.admin_partner_referrals() from public,anon;
grant execute on function public.admin_partner_referrals() to authenticated;
commit;
