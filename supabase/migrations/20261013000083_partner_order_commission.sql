/* ==========================================================================
   Partner codes per ORDER — 10% on every eligible order
   --------------------------------------------------------------------------
   Business rules (approved 13 Oct):
     - A Partner code (current code or any alias, e.g. ADONIS / POPSYADONIS)
       may be entered by ANY signed-in customer, new or existing, in the
       basket's promo field. It gives no discount; it records attribution.
     - Attribution is recorded on the ORDER at creation and can never change
       afterwards. How a customer signed up no longer earns commission.
     - The Partner earns floor(10% x (subtotal - discount)) on every order
       carrying their code once it is paid and Completed (not refunded),
       at or above the existing minimum (referral_min_order).
     - One commission per order, enforced by the database twice: a primary
       key on partner_commissions.order_id and the existing UNIQUE
       wallet_transactions.reference ('partner-referral:<order id>' — the same
       reference the 0081 first-order commissions used, so an order already
       paid under the old rule can never be paid again).
     - No retroactive awards: nothing here touches an existing order, referral,
       wallet or ledger row. The 14 historical commissions are COPIED into
       partner_commissions (source 'signup_link') so reporting reads one table.

   HOW THE CODE REACHES THE ORDER WITHOUT TOUCHING CHECKOUT
   create_checkout_order() is unchanged. The basket sends the code inside the
   customer snapshot it already sends (p_customer.partner_code); a BEFORE
   INSERT trigger on orders validates it, resolves the Partner, stamps
   orders.partner_id/partner_code and strips the key from the snapshot. Any
   partner_* value supplied any other way is discarded, and a BEFORE UPDATE
   trigger makes both columns immutable.

   Ordinary referral points are unchanged, except that a referral whose
   referrer is (or was recorded as) a Partner now earns neither points nor
   a signup-based commission (see referral_qualify below).
   ========================================================================== */

begin;

/* ---- 1. Per-order attribution ------------------------------------------ */

alter table public.orders
  add column if not exists partner_id   uuid references public.profiles (id) on delete set null,
  add column if not exists partner_code text;

create index if not exists orders_partner_idx on public.orders (partner_id) where partner_id is not null;

comment on column public.orders.partner_id is
  'Partner credited for this order (0083). Set once, at insert, from a validated '
  'Partner code; immutable afterwards.';

create or replace function public.orders_partner_attribution()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_code  text;
  v_owner uuid;
begin
  /* Only a code that arrived with the order, validated here, may set these. */
  new.partner_id := null;
  new.partner_code := null;

  v_code := upper(btrim(coalesce(new.customer ->> 'partner_code', '')));
  if new.customer ? 'partner_code' then
    new.customer := new.customer - 'partner_code';
  end if;
  if v_code = '' then return new; end if;

  select a.user_id into v_owner
    from public.referral_code_aliases a
    join public.partner_referrers p on p.user_id = a.user_id and p.enabled
   where a.code = v_code;

  if v_owner is null then
    raise exception 'That Partner code is not active. Remove it to continue.'
      using errcode = '22023';
  end if;
  if v_owner = new.user_id then
    raise exception 'You cannot use your own Partner code.' using errcode = '22023';
  end if;

  new.partner_id := v_owner;
  new.partner_code := v_code;
  return new;
end;
$$;
revoke all on function public.orders_partner_attribution() from public, anon, authenticated;

drop trigger if exists orders_partner_attribution on public.orders;
create trigger orders_partner_attribution
  before insert on public.orders
  for each row execute function public.orders_partner_attribution();

create or replace function public.orders_partner_immutable()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.partner_id is distinct from old.partner_id
     or new.partner_code is distinct from old.partner_code then
    raise exception 'Partner attribution cannot be changed after an order is placed'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.orders_partner_immutable() from public, anon, authenticated;

drop trigger if exists orders_partner_immutable on public.orders;
create trigger orders_partner_immutable
  before update on public.orders
  for each row execute function public.orders_partner_immutable();

/* ---- 2. One commission per order --------------------------------------- */

create table if not exists public.partner_commissions (
  order_id     uuid primary key references public.orders (id) on delete restrict,
  partner_id   uuid references public.profiles (id) on delete set null,
  code_used    text,
  base         integer not null check (base >= 0),
  amount       integer not null check (amount >= 0),
  wallet_tx_id uuid references public.wallet_transactions (id),
  source       text not null check (source in ('order_code', 'signup_link')),
  created_at   timestamptz not null default now()
);
create index if not exists partner_commissions_partner_idx
  on public.partner_commissions (partner_id, created_at desc);

alter table public.partner_commissions enable row level security;
revoke all on public.partner_commissions from anon, authenticated;
grant select on public.partner_commissions to authenticated;
drop policy if exists partner_commissions_read on public.partner_commissions;
create policy partner_commissions_read on public.partner_commissions
  for select to authenticated
  using (partner_id = (select auth.uid()) or (select public.is_manager()));

comment on table public.partner_commissions is
  'One row per order that earned (or was assessed for) a Partner commission. '
  'Written only by partner_order_commission(); historical 0081 first-order '
  'commissions copied in with source = signup_link.';

/* History: copy, do not move. Every existing commission keeps its referral
   row and its wallet transaction exactly as they are. */
insert into public.partner_commissions
  (order_id, partner_id, code_used, base, amount, wallet_tx_id, source, created_at)
select r.qualifying_order_id, r.referrer_id, r.code_used,
       coalesce(r.commission_base, 0), coalesce(r.commission_amount, 0),
       r.commission_transaction_id, 'signup_link', coalesce(r.rewarded_at, now())
  from public.referrals r
 where r.partner_reward and r.qualifying_order_id is not null
   and r.commission_amount is not null
on conflict (order_id) do nothing;

/* ---- 3. Earning: on the transition into paid + Completed --------------- */

create or replace function public.partner_order_commission()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_min     integer;
  v_base    integer;
  v_amount  integer;
  v_balance integer;
  v_tx      uuid;
begin
  if new.partner_id is null then return new; end if;
  if not (new.paid and new.status = 'Completed') then return new; end if;
  if new.payment_status = 'refunded' then return new; end if;
  if old.paid = new.paid and old.status is not distinct from new.status then return new; end if;

  /* The Partner must still be enabled when the order completes. */
  if not exists (select 1 from public.partner_referrers p
                  where p.user_id = new.partner_id and p.enabled) then
    return new;
  end if;
  if new.partner_id = new.user_id then return new; end if;

  v_min := public.reward_setting('referral_min_order', 2500);
  if new.total < v_min then return new; end if;

  v_base   := greatest(0, new.subtotal - new.discount);
  v_amount := floor(v_base::numeric * 0.10)::integer;

  /* The order's row in partner_commissions IS the duplicate guard. */
  insert into public.partner_commissions (order_id, partner_id, code_used, base, amount, source)
  values (new.id, new.partner_id, new.partner_code, v_base, v_amount, 'order_code')
  on conflict (order_id) do nothing;
  if not found then return new; end if;

  if v_amount > 0 then
    select balance into v_balance from public.wallets
     where user_id = new.partner_id and status = 'active' for update;
    if not found then raise exception 'Partner wallet is not active'; end if;

    /* Same reference namespace as 0081, so the UNIQUE reference also blocks
       a second credit for any order the old rule already paid. The wallet
       balance follows the ledger via apply_partner_referral_credit (0081). */
    insert into public.wallet_transactions
      (user_id, type, reason, amount, balance_after, reference, order_id, description)
    values (new.partner_id, 'credit', 'reward', v_amount, v_balance + v_amount,
            'partner-referral:' || new.id::text, new.id,
            'Partner commission · order ' || new.code)
    returning id into v_tx;

    update public.partner_commissions set wallet_tx_id = v_tx where order_id = new.id;

    perform public.notify_user(
      new.partner_id, 'reward', 'You earned a Partner commission',
      'Order ' || new.code || ' with your code ' || coalesce(new.partner_code, '') ||
        ' earned you ' || v_amount || ' naira in wallet credit.',
      null, false);
  end if;
  return new;

exception when others then
  /* The kitchen outranks the commission (same rule as referral_qualify):
     completing the order must never fail. Nothing above is kept; the order
     shows in the admin report as "eligible, not credited". */
  raise warning 'partner commission skipped for order %: %', new.id, sqlerrm;
  return new;
end;
$$;
revoke all on function public.partner_order_commission() from public, anon, authenticated;

drop trigger if exists orders_partner_commission on public.orders;
create trigger orders_partner_commission
  after update on public.orders
  for each row execute function public.partner_order_commission();

/* ---- 4. Signup-link commission retired; points rule unchanged ---------- */

/* 0081's referral_qualify(), reproduced line for line except the Partner
   branch: it no longer pays a commission (that is per order now) and treats
   a referrer who is currently a Partner the same as one recorded as such. */
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

  /* 0083: Partner commission is now earned PER ORDER, from the code applied
     to that order (orders.partner_id; see partner_order_commission()), never
     from how the customer signed up. A Partner — whether the referral was
     recorded in Partner mode or the referrer is a Partner now — still earns
     no ordinary points, and neither does the customer. The referral is only
     marked as having reached a qualifying order. */
  v_partner := v_ref.partner_reward or exists (
    select 1 from public.partner_referrers p
     where p.user_id = v_ref.referrer_id and p.enabled);
  if v_partner then
    update public.referrals
       set status = 'qualified', qualifying_order_id = new.id, qualified_at = now()
     where id = v_ref.id;
    return new;
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

/* ---- 5. Basket lookup -------------------------------------------------- */

/** What a code typed in the basket is. Display name only for Partners. */
create or replace function public.partner_code_lookup(p_code text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_code  text := upper(btrim(coalesce(p_code, '')));
  v_owner uuid;
  v_name  text;
begin
  if v_code !~ '^[A-Z0-9]{4,20}$' then
    return jsonb_build_object('kind', 'unknown', 'code', v_code);
  end if;
  select a.user_id into v_owner from public.referral_code_aliases a where a.code = v_code;
  if v_owner is null then
    return jsonb_build_object('kind', 'unknown', 'code', v_code);
  end if;
  if not exists (select 1 from public.partner_referrers p where p.user_id = v_owner and p.enabled) then
    return jsonb_build_object('kind', 'referral', 'code', v_code);
  end if;
  if v_owner = auth.uid() then
    return jsonb_build_object('kind', 'self', 'code', v_code);
  end if;
  select nullif(btrim(display_name), '') into v_name from public.profiles where id = v_owner;
  return jsonb_build_object('kind', 'partner', 'code', v_code, 'partner_name', coalesce(v_name, 'a Kandy''s Partner'));
end;
$$;
revoke all on function public.partner_code_lookup(text) from public;
grant execute on function public.partner_code_lookup(text) to anon, authenticated;

/* ---- 6. Admin reporting ------------------------------------------------ */

create or replace function public.admin_partner_report()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_min integer := public.reward_setting('referral_min_order', 2500);
begin
  if not public.is_manager() then
    raise exception 'Admin or owner required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'min_order', v_min,
    'partners', coalesce((
      select jsonb_agg(x order by (x ->> 'commission_total')::int desc, x ->> 'name')
        from (
          select jsonb_build_object(
            'id', p.id,
            'name', p.display_name,
            'enabled', pr.enabled,
            'current_code', rc.code,
            'codes', coalesce((select jsonb_agg(a.code order by (a.code = rc.code) desc, a.code)
                                 from public.referral_code_aliases a where a.user_id = p.id), '[]'::jsonb),
            'orders_attributed', (select count(*) from public.orders o where o.partner_id = p.id),
            'orders_open', (select count(*) from public.orders o where o.partner_id = p.id
                              and o.status not in ('Completed', 'Cancelled')),
            'qualifying_orders', (select count(*) from public.partner_commissions c where c.partner_id = p.id and c.amount > 0),
            'commission_total', coalesce((select sum(c.amount) from public.partner_commissions c where c.partner_id = p.id), 0),
            'ledger_total', coalesce((select sum(w.amount) from public.wallet_transactions w
                                       where w.user_id = p.id and w.reference like 'partner-referral:%'), 0),
            'not_credited', (select count(*) from public.orders o
                              where o.partner_id = p.id and o.paid and o.status = 'Completed'
                                and o.payment_status <> 'refunded' and o.total >= v_min
                                and not exists (select 1 from public.partner_commissions c where c.order_id = o.id)),
            'signups', (select count(*) from public.referrals r where r.referrer_id = p.id),
            'history', coalesce((
              select jsonb_agg(jsonb_build_object(
                       'order_code', o.code, 'customer', cp.display_name, 'code_used', c.code_used,
                       'at', c.created_at, 'base', c.base, 'amount', c.amount,
                       'credited', c.wallet_tx_id is not null, 'source', c.source)
                     order by c.created_at desc)
                from public.partner_commissions c
                join public.orders o on o.id = c.order_id
                left join public.profiles cp on cp.id = o.user_id
               where c.partner_id = p.id), '[]'::jsonb)
          ) as x
          from public.partner_referrers pr
          join public.profiles p on p.id = pr.user_id
          left join public.referral_codes rc on rc.user_id = p.id
        ) s), '[]'::jsonb),
    'generated_at', now());
end;
$$;
revoke all on function public.admin_partner_report() from public, anon;
grant execute on function public.admin_partner_report() to authenticated;

/* 0081's admin_partner_referrals(), now with readable order codes and a
   stable order (credited first, then newest signup). Shape otherwise kept. */
create or replace function public.admin_partner_referrals() returns jsonb
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
 'order_id',r.qualifying_order_id,'order_code',o.code,'base',r.commission_base,'commission',r.commission_amount,
 'credited',r.commission_transaction_id is not null,'partner_reward',r.partner_reward,
 'status',r.status,'signed_up_at',r.signed_up_at)
 order by (r.commission_transaction_id is not null) desc, r.signed_up_at desc),'[]')
 from public.referrals r join public.profiles p on p.id=r.referred_id
 left join public.orders o on o.id=r.qualifying_order_id
 where r.partner_reward or exists(select 1 from public.partner_referrers pr where pr.user_id=r.referrer_id)));
end $$;
revoke all on function public.admin_partner_referrals() from public,anon;
grant execute on function public.admin_partner_referrals() to authenticated;

commit;
