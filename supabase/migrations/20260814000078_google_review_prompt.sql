/* ==========================================================================
   Google review prompt
   --------------------------------------------------------------------------
   A customer whose order has genuinely been completed is, now and then,
   invited to leave an honest Google review. This migration adds the two
   things that invitation needs and nothing else:

     1. google_review_url in app_settings — the link, owned by the owner and
        changed from Admin → Settings without a deploy. It ships EMPTY, and
        empty means the feature is off everywhere.
     2. review_prompt_events — a per-customer record of the prompt being
        shown, snoozed ("Maybe later") or followed ("clicked"), so the
        cadence is decided on the server and is the same on every device and
        in the installed app.

   STRICTLY ADDITIVE. No order, payment, wallet, Paystack, Auth, Rewards or
   inventory function is touched. setting_label() and validate_app_setting()
   are re-created because a key cannot be labelled or validated any other
   way; both are reproduced from their current definitions (0074 and 0039)
   with ONE branch added to each, and nothing removed.

   WHAT "CLICKED" MEANS
   --------------------
   Only that the customer opened the Google link from our page. Google does
   not tell this site whether a review was then written, so nothing here
   records, implies or counts a submitted review.

   HONESTY
   -------
   The prompt is never conditioned on the internal star ratings (public.
   reviews); that table is not read here. Every eligible customer gets the
   same link, whatever they thought of the food. No reward of any kind is
   attached.

   ELIGIBILITY (all server-side, in my_review_prompt_state)
   -----------
     - a google_review_url is configured;
     - the order is the caller's, paid, and Completed (0077 already refuses
       Completed on an unpaid order; paid is checked again regardless);
     - it completed at least 45 minutes ago and no more than 14 days ago.

   CADENCE (per customer, not per order)
   -------
     - clicked            -> nothing for 180 days
     - "Maybe later"      -> nothing for 30 days
     - a second "Maybe later" since the last click -> never again
     - shown and ignored  -> at most one "shown" per Lagos calendar day; after
       the third separate shown day, nothing for the following 30 days
   ========================================================================== */

begin;

/* ---- 1. The setting ------------------------------------------------------ */

/* Empty string = off. setting_tier() already returns 'owner' for any key it
   does not name, so this is owner-only without touching that function. */
insert into public.app_settings (key, value) values
  ('google_review_url', '""'::jsonb)
on conflict (key) do nothing;

/* 0074's definition, plus the one new label. */
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
           when 'google_review_url'           then 'Google review link'
           else p_key
         end;
$$;

/*
   Is this an official Google review / Maps link? Only these forms:
     https://g.page/r/<id>[/review]          (Business Profile "Ask for reviews")
     https://g.page/<name>[/review]
     https://search.google.com/local/writereview?placeid=<id>
     https://www.google.com/maps/...  or  https://google.com/maps/...
     https://maps.google.com/...
     https://maps.app.goo.gl/<id>
     https://goo.gl/maps/<id>
   Anything else — http, another host, a lookalike such as
   g.page.example.com, whitespace or quotes — is refused. The check is
   anchored on the host, so a Google URL cannot be smuggled in a path.
*/
create or replace function public.is_google_review_url(p_url text)
returns boolean language sql immutable as $$
  select p_url is not null
     and length(p_url) <= 500
     and p_url !~ '[[:space:]"''<>\\]'
     and p_url ~* ('^https://('
           || 'g\.page/(r/)?[A-Za-z0-9_-]+(/review)?/?(\?[^#]*)?'
           || '|search\.google\.com/local/writereview\?placeid=[A-Za-z0-9_-]+(&[^#]*)?'
           || '|(www\.)?google\.com/maps([/?][^#]*)?'
           || '|maps\.google\.com([/?][^#]*)?'
           || '|maps\.app\.goo\.gl/[A-Za-z0-9_-]+/?(\?[^#]*)?'
           || '|goo\.gl/maps/[A-Za-z0-9_-]+/?'
           || ')$');
$$;

/* 0039's definition, plus the google_review_url branch. Every other line —
   the tier check, the rename lock, each shape branch and the updated_at
   stamp — is unchanged. */
create or replace function public.validate_app_setting()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_tier text := public.setting_tier(new.key);
  v_v    jsonb := new.value;
begin
  /* Server-side callers (migrations, seeds) have no JWT and are trusted by
     virtue of their database role. */
  if auth.uid() is not null then
    if v_tier = 'owner' and not public.is_owner() then
      raise exception '% is an owner-only setting', public.setting_label(new.key)
        using errcode = '42501',
              hint = 'Fees and service area are the owner''s to change.';
    end if;
    if not public.is_manager() then
      raise exception 'Settings are available to admins and the owner only'
        using errcode = '42501';
    end if;
  end if;

  /* The key identifies the row; it is not editable. There is no column grant
     for it either, so this is the second lock on the same door. */
  if new.key is distinct from old.key then
    raise exception 'A setting cannot be renamed' using errcode = '42501';
  end if;

  /* Shape. Each branch asserts exactly what the reading code assumes. */
  if new.key = 'ordering_enabled' then
    if jsonb_typeof(v_v) <> 'boolean' then
      raise exception 'Ordering must be true or false' using errcode = '22023';
    end if;

  elsif new.key = 'delivery_fee' then
    if jsonb_typeof(v_v) <> 'number' or (v_v #>> '{}')::numeric < 0
       or (v_v #>> '{}')::numeric > 100000
       or (v_v #>> '{}')::numeric <> floor((v_v #>> '{}')::numeric) then
      raise exception 'Delivery fee must be a whole number of naira between 0 and 100,000'
        using errcode = '22023';
    end if;

  elsif new.key = 'processing_fee_rate' then
    if jsonb_typeof(v_v) <> 'number'
       or (v_v #>> '{}')::numeric < 0 or (v_v #>> '{}')::numeric > 0.2 then
      raise exception 'Processing fee rate must be between 0 and 0.2'
        using errcode = '22023';
    end if;

  elsif new.key = 'takeaway_fee' then
    if jsonb_typeof(v_v) <> 'object'
       or jsonb_typeof(v_v -> 'standard') <> 'number'
       or jsonb_typeof(v_v -> 'combined') <> 'number'
       or (v_v ->> 'standard')::numeric < 0 or (v_v ->> 'standard')::numeric > 100000
       or (v_v ->> 'combined')::numeric < 0 or (v_v ->> 'combined')::numeric > 100000 then
      raise exception 'Takeaway packaging needs a standard and a combined amount in naira'
        using errcode = '22023';
    end if;

  elsif new.key = 'eta_minutes' then
    if jsonb_typeof(v_v) <> 'object'
       or jsonb_typeof(v_v -> 'pickup') <> 'number'
       or jsonb_typeof(v_v -> 'delivery') <> 'number'
       or (v_v ->> 'pickup')::numeric < 1 or (v_v ->> 'pickup')::numeric > 240
       or (v_v ->> 'delivery')::numeric < 1 or (v_v ->> 'delivery')::numeric > 240 then
      raise exception 'Estimated times need a pickup and a delivery figure between 1 and 240 minutes'
        using errcode = '22023';
    end if;

  elsif new.key = 'service_area' then
    if jsonb_typeof(v_v) <> 'object'
       or btrim(coalesce(v_v ->> 'label', '')) = ''
       or btrim(coalesce(v_v ->> 'state', '')) = ''
       or btrim(coalesce(v_v ->> 'country', '')) = '' then
      raise exception 'Service area needs a label, a state and a country'
        using errcode = '22023';
    end if;

  elsif new.key = 'google_review_url' then
    /* Empty turns the prompt off; anything else must be an official Google
       review or Maps link. */
    if jsonb_typeof(v_v) <> 'string'
       or (btrim(v_v #>> '{}') <> '' and not public.is_google_review_url(btrim(v_v #>> '{}'))) then
      raise exception 'Google review link must be empty (off) or an https link to g.page, search.google.com/local/writereview, google.com/maps, maps.app.goo.gl or goo.gl/maps'
        using errcode = '22023';
    end if;
    /* Stored trimmed, so what the customer is sent is exactly what passed. */
    new.value := to_jsonb(btrim(v_v #>> '{}'));
  end if;

  /* updated_at is in the column grant, so a client could otherwise backdate
     a change it had just made. */
  new.updated_at := now();
  return new;
end;
$$;

/* ---- 2. The event record ------------------------------------------------- */

create table if not exists public.review_prompt_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  order_id   uuid not null references public.orders (id) on delete cascade,
  event      text not null check (event in ('shown', 'later', 'clicked')),
  created_at timestamptz not null default now()
);

create index if not exists review_prompt_events_user_idx
  on public.review_prompt_events (user_id, event, created_at desc);

comment on table public.review_prompt_events is
  'Google review prompt: shown / later ("Maybe later") / clicked (the Google '
  'link was opened from our page). "clicked" is NOT a submitted review — '
  'Google does not report that back. Written only by record_review_prompt().';

/* No browser role reads or writes this table directly: RLS on, no policies,
   no grants. Both verbs go through the SECURITY DEFINER functions below. */
alter table public.review_prompt_events enable row level security;
revoke all on public.review_prompt_events from public, anon, authenticated;

/* When an order counts as completed: its Completed history row, falling back
   to the order's own updated_at for a row written before history existed. */
create or replace function public.review_prompt_completed_at(p_order_id uuid)
returns timestamptz language sql stable security definer set search_path = public as $$
  select coalesce(
    (select max(h.created_at) from public.order_status_history h
      where h.order_id = p_order_id and h.status = 'Completed'),
    (select o.updated_at from public.orders o where o.id = p_order_id));
$$;
revoke all on function public.review_prompt_completed_at(uuid) from public, anon, authenticated;

/*
   The one question the storefront asks: should THIS customer see the prompt
   now, and for which order? With p_order_id, only that order is considered
   (Order Detail); without, the customer's most recently completed eligible
   order is chosen (Orders list) — so several completed orders still produce
   one prompt.
*/
create or replace function public.my_review_prompt_state(p_order_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid         uuid := auth.uid();
  v_url         text;
  v_order       uuid;
  v_code        text;
  v_last_click  timestamptz;
  v_last_later  timestamptz;
  v_laters      integer;
  v_cycle       timestamptz;
  v_today       date := (now() at time zone 'Africa/Lagos')::date;
  v_run         integer := 0;
  v_snooze_from date;
  v_snooze_to   date;
  d             record;
begin
  if v_uid is null then
    return jsonb_build_object('show', false, 'reason', 'signed_out');
  end if;

  select btrim(value #>> '{}') into v_url
    from public.app_settings where key = 'google_review_url';
  if coalesce(v_url, '') = '' or not public.is_google_review_url(v_url) then
    return jsonb_build_object('show', false, 'reason', 'off');
  end if;

  /* The order: the caller's, paid, Completed, 45 minutes to 14 days ago. */
  select o.id, o.code into v_order, v_code
    from public.orders o
   where o.user_id = v_uid
     and o.status = 'Completed'
     and o.paid = true
     and (p_order_id is null or o.id = p_order_id)
     and public.review_prompt_completed_at(o.id)
           between now() - interval '14 days' and now() - interval '45 minutes'
   order by public.review_prompt_completed_at(o.id) desc
   limit 1;
  if v_order is null then
    return jsonb_build_object('show', false, 'reason', 'no_eligible_order');
  end if;

  /* Clicked: quiet for 180 days. */
  select max(created_at) into v_last_click
    from public.review_prompt_events where user_id = v_uid and event = 'clicked';
  if v_last_click is not null and now() < v_last_click + interval '180 days' then
    return jsonb_build_object('show', false, 'reason', 'clicked_recently');
  end if;

  /* "Maybe later" since the last click: the second one ends it; the first
     is a 30-day snooze. */
  select count(*), max(created_at) into v_laters, v_last_later
    from public.review_prompt_events
   where user_id = v_uid and event = 'later'
     and created_at > coalesce(v_last_click, '-infinity'::timestamptz);
  if v_laters >= 2 then
    return jsonb_build_object('show', false, 'reason', 'declined');
  end if;
  if v_last_later is not null and now() < v_last_later + interval '30 days' then
    return jsonb_build_object('show', false, 'reason', 'snoozed');
  end if;

  /* Ignored: walk the distinct shown days since the last later/click. The
     third shown day in a run starts a 30-day quiet spell (the day after it
     through 30 days later); a shown day after that spell starts a new run. */
  v_cycle := greatest(coalesce(v_last_click, '-infinity'::timestamptz),
                      coalesce(v_last_later, '-infinity'::timestamptz));
  for d in
    select distinct (created_at at time zone 'Africa/Lagos')::date as day
      from public.review_prompt_events
     where user_id = v_uid and event = 'shown' and created_at > v_cycle
     order by 1
  loop
    if v_snooze_to is not null and d.day >= v_snooze_to then
      v_run := 0; v_snooze_from := null; v_snooze_to := null;
    end if;
    if v_snooze_from is null then
      v_run := v_run + 1;
      if v_run >= 3 then
        v_snooze_from := d.day + 1;
        v_snooze_to   := d.day + 31;
      end if;
    end if;
  end loop;
  if v_snooze_from is not null and v_today >= v_snooze_from and v_today < v_snooze_to then
    return jsonb_build_object('show', false, 'reason', 'ignored');
  end if;

  return jsonb_build_object(
    'show', true, 'reason', 'eligible',
    'order_id', v_order, 'order_code', v_code, 'url', v_url);
end;
$$;

/*
   Record what the customer did. Only against the caller's own paid,
   Completed order — anyone else's order, or one that is not finished, is
   refused. "shown" is written at most once per customer per Lagos day, so
   re-opening the page does not inflate the count.
*/
create or replace function public.record_review_prompt(p_order_id uuid, p_event text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := (now() at time zone 'Africa/Lagos')::date;
begin
  if v_uid is null then
    raise exception 'Please sign in.' using errcode = '42501';
  end if;
  if p_event is null or p_event not in ('shown', 'later', 'clicked') then
    raise exception 'Unknown review prompt event' using errcode = '22023';
  end if;
  if not exists (
       select 1 from public.orders o
        where o.id = p_order_id and o.user_id = v_uid
          and o.status = 'Completed' and o.paid = true) then
    raise exception 'That order is not yours or is not completed'
      using errcode = '42501';
  end if;

  if p_event = 'shown' and exists (
       select 1 from public.review_prompt_events
        where user_id = v_uid and event = 'shown'
          and (created_at at time zone 'Africa/Lagos')::date = v_today) then
    return jsonb_build_object('recorded', false, 'reason', 'already_shown_today');
  end if;

  insert into public.review_prompt_events (user_id, order_id, event)
  values (v_uid, p_order_id, p_event);
  return jsonb_build_object('recorded', true);
end;
$$;

revoke all on function public.my_review_prompt_state(uuid) from public, anon;
revoke all on function public.record_review_prompt(uuid, text) from public, anon;
grant execute on function public.my_review_prompt_state(uuid) to authenticated;
grant execute on function public.record_review_prompt(uuid, text) to authenticated;

commit;
