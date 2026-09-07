/* ==========================================================================
   Phase 13 — Kandy Rewards: referrals, points, and the wallet door
   --------------------------------------------------------------------------
   Three tables, one settings block, and a single narrow path by which points
   can ever become money. Everything else already existed and is reused:
   handle_new_user() for attribution, the orders status model for
   qualification, notify_user() for the bell, app_settings for the economics,
   log_admin_action() for the audit, and the wallets/wallet_transactions
   ledger for the credit.

   POINTS ARE NOT MONEY
   --------------------
   That sentence is the whole design. Points live in their own ledger, have
   their own expiry, and cannot be withdrawn. They become naira only inside
   redeem_reward_points(), which takes NO ARGUMENTS — not an amount, not a
   rate, not a user. Everything it needs it reads from the database and from
   auth.uid(). There is no number a browser can send that changes what a
   redemption is worth.

   EXPIRY WITHOUT A SCHEDULER
   --------------------------
   Points expire after a configurable window, and there is no cron job here
   on purpose. Earning rows are LOTS: each carries points_remaining and
   expires_at. The balance is the sum of points_remaining over lots that have
   not expired, so an expired lot simply stops counting on the next read. No
   background process has to run, nothing drifts if one fails to run, and an
   expired lot is still visible for reporting. Redemption consumes lots
   oldest-first, so points are spent before they age out.

   WHY A NEW WALLET REASON
   -----------------------
   wallet_transactions.reason is a CHECK list. Redemptions could have been
   filed as 'adjustment', but that value means "an owner corrected something
   by hand" and conflating the two would make the ledger lie about who did
   what. The list gains 'reward'. Additive: no existing row changes, no
   existing constraint loosens.
   ========================================================================== */

begin;

/* ---- 0. The pre-existing coupon hole ----------------------------------- */

/*
   Found during the Phase 13 audit, not introduced by it. coupons has used
   is_admin() for writes since 0005, and is_admin() has meant STAFF AND ABOVE
   since 0037 — so any staff account could mint a discount. This is the same
   drift announcements had before 0073, and it gets the same treatment.

   The read policy is untouched: customers and anon still see active,
   in-date coupons, so checkout validation inside create_checkout_order()
   behaves exactly as before. Only who may WRITE changes.
*/
drop policy if exists coupons_admin_insert on public.coupons;
drop policy if exists coupons_admin_update on public.coupons;
drop policy if exists coupons_admin_delete on public.coupons;
drop policy if exists coupons_admin_write  on public.coupons;   /* 0003's name */

create policy coupons_manager_insert on public.coupons
  for insert to authenticated with check ((select public.is_manager()));
create policy coupons_manager_update on public.coupons
  for update to authenticated
  using ((select public.is_manager())) with check ((select public.is_manager()));
create policy coupons_manager_delete on public.coupons
  for delete to authenticated using ((select public.is_manager()));

/* ---- 1. Settings: the owner controls the economics --------------------- */

insert into public.app_settings (key, value) values
  ('referral_referrer_points',    '100'::jsonb),
  ('referral_referred_points',    '100'::jsonb),
  ('referral_min_order',          '2500'::jsonb),
  ('referral_points_expiry_days', '90'::jsonb),
  ('reward_redemption_points',    '500'::jsonb),
  ('reward_redemption_naira',     '500'::jsonb)
on conflict (key) do nothing;

/* setting_tier() already returns 'owner' for anything it does not name, so
   these are owner-only without another line. The labels are added so the
   Settings screen and the audit summary read as English. */
create or replace function public.setting_label(p_key text)
returns text language sql immutable as $$
  select case p_key
           when 'ordering_enabled'    then 'Ordering'
           when 'eta_minutes'         then 'Estimated times'
           when 'delivery_fee'        then 'Delivery fee'
           when 'takeaway_fee'        then 'Takeaway packaging'
           when 'processing_fee_rate' then 'Processing fee rate'
           when 'service_area'        then 'Service area'
           when 'referral_referrer_points'    then 'Referral points — referrer'
           when 'referral_referred_points'    then 'Referral points — new customer'
           when 'referral_min_order'          then 'Minimum qualifying order'
           when 'referral_points_expiry_days' then 'Points expiry (days)'
           when 'reward_redemption_points'    then 'Points per redemption'
           when 'reward_redemption_naira'     then 'Naira per redemption'
           else p_key
         end;
$$;

/** One place that reads a whole-naira / whole-point setting. */
create or replace function public.reward_setting(p_key text, p_default integer)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::integer
                     from public.app_settings where key = p_key), p_default);
$$;
revoke all on function public.reward_setting(text, integer) from public, anon, authenticated;

/* ---- 2. Referral codes -------------------------------------------------- */

create table if not exists public.referral_codes (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  code       text not null unique,
  created_at timestamptz not null default now()
);

alter table public.referral_codes enable row level security;

comment on table public.referral_codes is
  'One stable share code per customer. Generated server-side by '
  'my_referral_code(); never derived from the user uuid, so the code leaks '
  'no internal identifier.';

/*
   The alphabet omits 0/O/1/I/L so a code read aloud or off a phone screen
   cannot be mistyped into somebody else''s code. Collisions are retried
   rather than trusted to chance.
*/
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
    exit when not exists (select 1 from public.referral_codes where code = v_code);
    v_try := v_try + 1;
    if v_try > 20 then
      raise exception 'Could not allocate a referral code' using errcode = '55000';
    end if;
  end loop;
  return v_code;
end;
$$;
revoke all on function public.generate_referral_code() from public, anon, authenticated;

/** The caller's own code, created on first ask. No backfill, no argument. */
create or replace function public.my_referral_code()
returns text language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_code text;
begin
  if v_uid is null then
    raise exception 'Sign in to get your referral code' using errcode = '28000';
  end if;

  select code into v_code from public.referral_codes where user_id = v_uid;
  if v_code is not null then return v_code; end if;

  v_code := public.generate_referral_code();
  insert into public.referral_codes (user_id, code) values (v_uid, v_code)
  on conflict (user_id) do nothing;

  /* A concurrent first call may have won; read back whatever stuck. */
  select code into v_code from public.referral_codes where user_id = v_uid;
  return v_code;
end;
$$;
revoke all on function public.my_referral_code() from public, anon;
grant execute on function public.my_referral_code() to authenticated;

/* ---- 3. Referrals ------------------------------------------------------- */

create table if not exists public.referrals (
  id                  uuid primary key default gen_random_uuid(),
  referrer_id         uuid references public.profiles (id) on delete set null,
  referred_id         uuid references public.profiles (id) on delete set null,
  status              text not null default 'signed_up'
                        check (status in ('signed_up', 'qualified', 'rewarded', 'void')),
  qualifying_order_id uuid references public.orders (id) on delete set null,
  signed_up_at        timestamptz not null default now(),
  qualified_at        timestamptz,
  rewarded_at         timestamptz,
  /* A referral is about two different people. Always. */
  constraint referrals_not_self check (referrer_id is null or referrer_id <> referred_id)
);

/*
   These two indexes ARE the fraud protection, and they are indexes rather
   than procedural checks because a constraint cannot be raced.

   one_referrer   a customer can be referred exactly once, for ever. A second
                  attempt is a duplicate key, not a judgement call.
   one_qualifier  an order can qualify exactly one referral, so replaying the
                  same status transition cannot pay twice.
*/
create unique index if not exists referrals_one_referrer_idx
  on public.referrals (referred_id) where referred_id is not null;
create unique index if not exists referrals_one_qualifier_idx
  on public.referrals (qualifying_order_id) where qualifying_order_id is not null;
create index if not exists referrals_referrer_idx on public.referrals (referrer_id);

alter table public.referrals enable row level security;

comment on table public.referrals is
  'Who invited whom, and how far that invitation got. Rows are written only '
  'by SECURITY DEFINER functions; authenticated holds no INSERT, UPDATE or '
  'DELETE grant, so a browser cannot create, redirect or advance a referral.';

/* ---- 4. The points ledger ---------------------------------------------- */

create table if not exists public.reward_points (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  kind             text not null check (kind in ('earn', 'redeem')),
  /* Signed: + for earning, - for spending. The two together are the ledger. */
  points           integer not null check (points <> 0),
  /* Lot accounting, earn rows only. Redemption draws these down oldest-first
     and the balance is their sum, so expiry needs no scheduled job. */
  points_remaining integer check (points_remaining >= 0),
  expires_at       timestamptz,
  source           text not null
                     check (source in ('referral_referrer', 'referral_referred', 'redemption')),
  referral_id      uuid references public.referrals (id) on delete set null,
  redemption_id    uuid,
  created_at       timestamptz not null default now(),
  constraint reward_points_earn_shape check (
    (kind = 'earn'   and points > 0 and points_remaining is not null and expires_at is not null)
    or
    (kind = 'redeem' and points < 0 and points_remaining is null     and expires_at is null)
  )
);

/*
   ONE REWARD PER SIDE PER REFERRAL, enforced by the database rather than by
   remembering to check. If issuance runs twice for any reason — a retried
   trigger, two concurrent transitions — the second insert is a duplicate key
   and the whole thing rolls back rather than paying twice.
*/
create unique index if not exists reward_points_one_per_referral_side_idx
  on public.reward_points (referral_id, source) where referral_id is not null;
create index if not exists reward_points_user_idx on public.reward_points (user_id, created_at desc);
create index if not exists reward_points_lots_idx
  on public.reward_points (user_id, expires_at) where kind = 'earn' and points_remaining > 0;

alter table public.reward_points enable row level security;

comment on table public.reward_points is
  'Kandy Rewards points. NOT money: points cannot be withdrawn and become '
  'naira only through redeem_reward_points(). Earn rows are lots carrying '
  'points_remaining and expires_at, so the balance is a sum over unexpired '
  'lots and expiry needs no scheduled job.';

create table if not exists public.reward_redemptions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  points_spent   integer not null check (points_spent > 0),
  naira_credited integer not null check (naira_credited > 0),
  created_at     timestamptz not null default now()
);
create index if not exists reward_redemptions_user_idx
  on public.reward_redemptions (user_id, created_at desc);

/* Declared here rather than inline: reward_points is created first, so the
   reference could not exist until reward_redemptions did. */
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'reward_points_redemption_fk') then
    alter table public.reward_points
      add constraint reward_points_redemption_fk
      foreign key (redemption_id) references public.reward_redemptions (id)
      on delete set null;
  end if;
end $$;

alter table public.reward_redemptions enable row level security;

/* ---- 5. RLS: read your own, write nothing ------------------------------ */

/*
   The shape notifications uses, and for the same reason: `authenticated` is
   granted SELECT and nothing else on all four tables, so there is no INSERT
   or UPDATE verb for a policy to have to police. A customer cannot award
   themselves a point, cannot move a referral to 'rewarded', and cannot
   change who referred them, because those statements are refused before any
   policy is consulted.
*/
revoke all on public.referral_codes     from anon, authenticated;
revoke all on public.referrals          from anon, authenticated;
revoke all on public.reward_points      from anon, authenticated;
revoke all on public.reward_redemptions from anon, authenticated;

grant select on public.referral_codes     to authenticated;
grant select on public.referrals          to authenticated;
grant select on public.reward_points      to authenticated;
grant select on public.reward_redemptions to authenticated;

drop policy if exists referral_codes_own on public.referral_codes;
create policy referral_codes_own on public.referral_codes
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_manager()));

/* Both sides of a referral may see that it exists. The SELECT returns ids,
   not people — the customer-facing RPC is what decides that a referrer sees
   a count and a status and never a name, an email or a phone number. */
drop policy if exists referrals_own on public.referrals;
create policy referrals_own on public.referrals
  for select to authenticated
  using (referrer_id = (select auth.uid())
         or referred_id = (select auth.uid())
         or (select public.is_manager()));

drop policy if exists reward_points_own on public.reward_points;
create policy reward_points_own on public.reward_points
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_manager()));

drop policy if exists reward_redemptions_own on public.reward_redemptions;
create policy reward_redemptions_own on public.reward_redemptions
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_manager()));

/* ---- 6. Attribution, inside the existing signup trigger ---------------- */

/*
   handle_new_user() already runs as the definer on every auth.users insert
   and already reads raw_user_meta_data. The referral code rides that same
   channel, and is VALIDATED HERE rather than trusted: the client sends a
   string, and this decides whether it names a real, other, customer.

   The whole referral block is wrapped so that nothing about it can stop an
   account being created. A bad code, a missing code, a race — the customer
   still signs up, simply without a referral. Growth features do not get to
   break the front door.
*/
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code     text;
  v_referrer uuid;
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
      select user_id into v_referrer
        from public.referral_codes where code = v_code;

      /* A real code, belonging to somebody else. Self-referral fails here on
         the id comparison and again on referrals_not_self. */
      if v_referrer is not null and v_referrer <> new.id then
        insert into public.referrals (referrer_id, referred_id, status)
        values (v_referrer, new.id, 'signed_up')
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

/*
   CREATE OR REPLACE preserves a function's ACL, so the revokes 0005 and 0006
   placed on handle_new_user() survive the replacement above. Re-asserted
   anyway: this migration rewrites a trigger function that sits on auth.users,
   and "it should still be revoked" is not a thing to leave to inference.
*/
revoke all on function public.handle_new_user() from public, anon, authenticated;

/* Likewise for setting_label(), which 0039 exposes to authenticated so the
   Settings screen can name a row. Same grant, restated. */
revoke all on function public.setting_label(text) from public, anon;
grant execute on function public.setting_label(text) to authenticated;

/* ---- 7. Qualification, off the existing order status model ------------- */

/*
   A referral qualifies on the referred customer's FIRST order that is paid,
   Completed, and at least the configured minimum. Nothing here invents a
   payment state: paid and status are the columns the rest of the app has
   always used.

   Awarding is the same statement as qualifying. The two unique indexes make
   it idempotent: referrals_one_qualifier_idx means this order can only ever
   be the qualifier once, and reward_points_one_per_referral_side_idx means
   each side of the referral can only ever be paid once. Re-running the same
   transition changes nothing.
*/
create or replace function public.referral_qualify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_ref        public.referrals%rowtype;
  v_min        integer;
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
revoke all on function public.referral_qualify() from public, anon, authenticated;

drop trigger if exists orders_referral_qualify on public.orders;
create trigger orders_referral_qualify
  after update on public.orders
  for each row execute function public.referral_qualify();

/* ---- 8. Reading your own rewards --------------------------------------- */

/** Balance, lifetime totals and referral counts for the caller. Own data
    only — there is no user argument to point somewhere else. */
create or replace function public.my_rewards()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Sign in to see your rewards' using errcode = '28000';
  end if;
  return jsonb_build_object(
    'code', (select code from public.referral_codes where user_id = v_uid),
    'available', coalesce((select sum(points_remaining) from public.reward_points
                            where user_id = v_uid and kind = 'earn'
                              and expires_at > now() and points_remaining > 0), 0),
    'earned',    coalesce((select sum(points) from public.reward_points
                            where user_id = v_uid and kind = 'earn'), 0),
    'redeemed',  coalesce((select sum(points_spent) from public.reward_redemptions
                            where user_id = v_uid), 0),
    'expiring',  coalesce((select sum(points_remaining) from public.reward_points
                            where user_id = v_uid and kind = 'earn'
                              and points_remaining > 0
                              and expires_at > now()
                              and expires_at < now() + interval '14 days'), 0),
    /* Counts only. A referrer learns that somebody joined, never who. */
    'referrals_total',   (select count(*) from public.referrals where referrer_id = v_uid),
    'referrals_pending', (select count(*) from public.referrals
                           where referrer_id = v_uid and status = 'signed_up'),
    'referrals_success', (select count(*) from public.referrals
                           where referrer_id = v_uid and status in ('qualified','rewarded')),
    'rate_points', public.reward_setting('reward_redemption_points', 500),
    'rate_naira',  public.reward_setting('reward_redemption_naira', 500),
    'min_order',   public.reward_setting('referral_min_order', 2500)
  );
end;
$$;
revoke all on function public.my_rewards() from public, anon;
grant execute on function public.my_rewards() to authenticated;

/* ---- 9. The only door from points to money ----------------------------- */

/*
   NO ARGUMENTS. Not an amount, not a rate, not a user id.

   Everything this needs it reads for itself: who is calling from auth.uid(),
   what a redemption costs and pays from app_settings, and what the customer
   has from the ledger. There is therefore no number a browser can send that
   changes what a redemption is worth, and no way to aim one at another
   account. That is the entire financial-authority argument for this feature.

   The wallet half deliberately mirrors settle_wallet_funding(): lock the
   wallet row, insert the ledger entry with a UNIQUE reference, and only then
   move the balance. The reference is 'reward:<redemption uuid>', so even a
   retry that somehow reached this far cannot bank the same redemption twice.
*/
create or replace function public.redeem_reward_points()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid       uuid := auth.uid();
  v_cost      integer;
  v_pay       integer;
  v_available integer;
  v_balance   integer;
  v_status    text;
  v_redemption uuid;
  v_left      integer;
  v_take      integer;
  r           record;
begin
  if v_uid is null then
    raise exception 'Sign in to redeem your points' using errcode = '28000';
  end if;

  v_cost := public.reward_setting('reward_redemption_points', 500);
  v_pay  := public.reward_setting('reward_redemption_naira', 500);
  if v_cost <= 0 or v_pay <= 0 then
    raise exception 'Rewards redemption is not available right now'
      using errcode = '22023';
  end if;

  /* Lock the wallet FIRST and hold it for the whole transaction: it is the
     one row both halves of this operation touch, so taking it first is what
     stops two concurrent redemptions from each seeing enough points. */
  select balance, status into v_balance, v_status
    from public.wallets where user_id = v_uid for update;
  if v_balance is null then
    raise exception 'No wallet for this account' using errcode = 'P0002';
  end if;
  if v_status <> 'active' then
    raise exception 'This wallet is not active' using errcode = '42501';
  end if;

  select coalesce(sum(points_remaining), 0) into v_available
    from public.reward_points
   where user_id = v_uid and kind = 'earn'
     and expires_at > now() and points_remaining > 0;

  if v_available < v_cost then
    raise exception 'Not enough points yet. % of % needed.', v_available, v_cost
      using errcode = '22023';
  end if;

  insert into public.reward_redemptions (user_id, points_spent, naira_credited)
  values (v_uid, v_cost, v_pay)
  returning id into v_redemption;

  /* Spend the oldest unexpired lots first, so points are used before they
     age out rather than after. */
  v_left := v_cost;
  for r in
    select id, points_remaining from public.reward_points
     where user_id = v_uid and kind = 'earn'
       and expires_at > now() and points_remaining > 0
     order by expires_at asc, created_at asc
     for update
  loop
    exit when v_left <= 0;
    v_take := least(v_left, r.points_remaining);
    update public.reward_points
       set points_remaining = points_remaining - v_take
     where id = r.id;
    v_left := v_left - v_take;
  end loop;

  if v_left > 0 then
    /* Unreachable: the balance was checked under the wallet lock. Raising
       rolls the whole thing back rather than crediting a wallet from points
       that were not there. */
    raise exception 'Points balance changed during redemption'
      using errcode = '40001';
  end if;

  insert into public.reward_points
    (user_id, kind, points, points_remaining, expires_at, source, redemption_id)
  values (v_uid, 'redeem', -v_cost, null, null, 'redemption', v_redemption);

  insert into public.wallet_transactions
    (user_id, type, reason, amount, balance_after, reference, description)
  values (v_uid, 'credit', 'reward', v_pay, v_balance + v_pay,
          'reward:' || v_redemption::text,
          'Kandy Rewards — ' || v_cost || ' points redeemed');

  update public.wallets
     set balance = balance + v_pay, updated_at = now()
   where user_id = v_uid;

  perform public.notify_user(
    v_uid, 'reward', 'Your points are now wallet credit',
    v_cost || ' Kandy Rewards points have been converted to a wallet credit.',
    null, false);

  return jsonb_build_object('status', 'ok', 'points_spent', v_cost,
                            'naira_credited', v_pay,
                            'balance', v_balance + v_pay,
                            'available', v_available - v_cost);
end;
$$;
revoke all on function public.redeem_reward_points() from public, anon;
grant execute on function public.redeem_reward_points() to authenticated;

/* The redemption credit needs a reason of its own. 'adjustment' exists but
   means "an owner corrected this by hand", and reusing it would make the
   ledger misdescribe an automated conversion. Additive only. */
alter table public.wallet_transactions
  drop constraint if exists wallet_transactions_reason_check;
alter table public.wallet_transactions
  add constraint wallet_transactions_reason_check
  check (reason in ('funding', 'order_payment', 'refund', 'adjustment', 'reward'));

/* ---- 10. Manager analytics --------------------------------------------- */

/*
   Aggregates only. No names, no emails, no phone numbers, no per-customer
   rows — a manager needs to know whether the programme works, not who
   invited whom.
*/
create or replace function public.admin_referral_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_manager() then
    raise exception 'Referral analytics are available to admins and the owner only'
      using errcode = '42501';
  end if;
  return jsonb_build_object(
    'referrals_total',   (select count(*) from public.referrals),
    'referrals_pending', (select count(*) from public.referrals where status = 'signed_up'),
    'referrals_success', (select count(*) from public.referrals
                           where status in ('qualified','rewarded')),
    'codes_issued',      (select count(*) from public.referral_codes),
    'points_issued',     coalesce((select sum(points) from public.reward_points
                                    where kind = 'earn'), 0),
    'points_redeemed',   coalesce((select sum(points_spent) from public.reward_redemptions), 0),
    'points_outstanding',coalesce((select sum(points_remaining) from public.reward_points
                                    where kind = 'earn' and expires_at > now()), 0),
    'naira_credited',    coalesce((select sum(naira_credited) from public.reward_redemptions), 0),
    'referral_orders',   (select count(*) from public.referrals
                           where qualifying_order_id is not null),
    'referral_revenue',  coalesce((select sum(o.total) from public.referrals r
                                     join public.orders o on o.id = r.qualifying_order_id), 0),
    'settings', jsonb_build_object(
      'referrer_points', public.reward_setting('referral_referrer_points', 100),
      'referred_points', public.reward_setting('referral_referred_points', 100),
      'min_order',       public.reward_setting('referral_min_order', 2500),
      'expiry_days',     public.reward_setting('referral_points_expiry_days', 90),
      'rate_points',     public.reward_setting('reward_redemption_points', 500),
      'rate_naira',      public.reward_setting('reward_redemption_naira', 500)),
    'generated_at', now()
  );
end;
$$;
revoke all on function public.admin_referral_overview() from public, anon;
grant execute on function public.admin_referral_overview() to authenticated;

commit;
