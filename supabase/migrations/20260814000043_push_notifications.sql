/* ==========================================================================
   Phase 13 (1/2) — one notification event, several delivery channels
   --------------------------------------------------------------------------
   public.notifications already exists and already carries the in-app centre
   and the realtime badge (Phase 11). This migration does NOT add a second
   notification system: it adds the missing channel — Web Push — and hangs it
   off the same row.

       DB event (order / chat / ticket / payment)
            |
            v
       notifications  <-- ONE row per (recipient, event)
            |
            +--> in-app centre      (already: SELECT under RLS)
            +--> realtime badge     (already: supabase_realtime publication)
            +--> Web Push           (new: dispatch trigger -> Edge Function)

   §14 asks that one event not become three records, and it does not: push is
   a column on the row (push_sent_at), not a copy of it.

   WHY PUSH FIRES ON INSERT ONLY
   -----------------------------
   notify_user(..., p_collapse => true) refreshes an existing UNREAD row
   rather than stacking a new one — that is how six rapid chat replies stay
   one bell entry. Pushing on UPDATE as well would undo that at the OS level
   and buzz the phone six times. So the dispatch trigger is AFTER INSERT.
   Order status changes are never collapsed (each is its own row), so every
   status change does push — which is the case that matters.

   WHAT A BROWSER CANNOT DO
   ------------------------
   `authenticated` still has NO INSERT grant on notifications, so no client
   can create one for anybody. push_subscriptions goes further and has no
   grants at all: every route in or out is a SECURITY DEFINER function, so a
   customer cannot read, move or delete another customer's subscription even
   with a stolen endpoint string.
   ========================================================================== */

begin;

/* ---- Delivery state on the existing row -------------------------------- */

alter table public.notifications
  add column if not exists push_sent_at timestamptz;

comment on column public.notifications.push_sent_at is
  'When the Web Push fan-out was dispatched for this row. Null = never '
  'dispatched. Set by the dispatcher, and the reason a retry cannot double-send.';

/* ---- Subscriptions ----------------------------------------------------- */

create table if not exists public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  /* The push service URL. Unique across the table: one physical browser has
     one endpoint, and if it is re-registered the row moves rather than
     duplicating. */
  endpoint     text not null unique,
  /* The two halves of RFC 8291's key agreement. Nothing else from the
     subscription is stored, because nothing else is needed to send. */
  p256dh       text not null,
  auth         text not null,
  user_agent   text not null default '',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  /* A push service answering 404/410 means the subscription is gone. */
  failures     integer not null default 0
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

/* No grants and no policies. Deliberately: see the header. */
revoke all on public.push_subscriptions from anon, authenticated;

/* ---- Preferences ------------------------------------------------------- */

/*
   Deliberately small (§17). These are the switches this phase actually
   needs — not a settings system. A missing row means "all on", so nobody has
   to be back-filled and a new account works before it has ever opened
   preferences.
*/
create table if not exists public.notification_preferences (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  push_orders      boolean not null default true,
  push_support     boolean not null default true,
  push_marketing   boolean not null default true,
  email_orders     boolean not null default true,
  sound_new_order  boolean not null default true,
  updated_at       timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;

revoke all on public.notification_preferences from anon, authenticated;
grant select on public.notification_preferences to authenticated;
/* Only the five switches are writable, and only on your own row. */
grant insert (user_id, push_orders, push_support, push_marketing,
              email_orders, sound_new_order) on public.notification_preferences to authenticated;
grant update (push_orders, push_support, push_marketing,
              email_orders, sound_new_order, updated_at) on public.notification_preferences to authenticated;

drop policy if exists notification_preferences_own on public.notification_preferences;
create policy notification_preferences_own on public.notification_preferences
  for all to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

/** Fails OPEN: no row means every channel is on. */
create or replace function public.wants_push(p_user_id uuid, p_type text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select case
              when p_type in ('order', 'payment') then p.push_orders
              when p_type in ('chat', 'support')  then p.push_support
              else p.push_marketing
            end
       from public.notification_preferences p
      where p.user_id = p_user_id),
    true);
$$;

revoke all on function public.wants_push(uuid, text) from public;

/* ---- Registering a device ---------------------------------------------- */

/*
   An RPC rather than an INSERT policy, because of one case a policy cannot
   express: the SAME browser signing in as a different account. The endpoint
   is unique, so the old row has to go — but only that endpoint's row, and
   only as a side effect of that browser re-registering itself. A caller can
   never name a row belonging to someone else, because the only thing they
   can name is an endpoint their own browser just produced.
*/
create or replace function public.register_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default ''
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'Sign in to enable notifications' using errcode = '28000';
  end if;
  if coalesce(btrim(p_endpoint), '') = ''
     or coalesce(btrim(p_p256dh), '') = ''
     or coalesce(btrim(p_auth), '') = '' then
    raise exception 'Incomplete push subscription' using errcode = '22023';
  end if;
  if p_endpoint !~ '^https://' then
    raise exception 'A push endpoint must be https' using errcode = '22023';
  end if;

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (v_uid, btrim(p_endpoint), btrim(p_p256dh), btrim(p_auth),
          left(coalesce(p_user_agent, ''), 300))
  on conflict (endpoint) do update
    set user_id      = v_uid,
        p256dh       = excluded.p256dh,
        auth         = excluded.auth,
        user_agent   = excluded.user_agent,
        last_seen_at = now(),
        failures     = 0
  returning id into v_id;

  return jsonb_build_object('status', 'registered', 'id', v_id);
end;
$$;

/** Only ever removes the caller's own row. */
create or replace function public.unregister_push_subscription(p_endpoint text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_n   integer;
begin
  if v_uid is null then
    raise exception 'Sign in first' using errcode = '28000';
  end if;
  delete from public.push_subscriptions
   where endpoint = btrim(p_endpoint) and user_id = v_uid;
  get diagnostics v_n = row_count;
  return jsonb_build_object('status', 'removed', 'count', v_n);
end;
$$;

/** What the caller has registered. Never anybody else's. */
create or replace function public.my_push_subscriptions()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'user_agent', s.user_agent,
             'created_at', s.created_at, 'last_seen_at', s.last_seen_at)
           order by s.created_at desc)
      from public.push_subscriptions s where s.user_id = v_uid), '[]'::jsonb);
end;
$$;

revoke all on function public.register_push_subscription(text, text, text, text) from public;
revoke all on function public.unregister_push_subscription(text) from public;
revoke all on function public.my_push_subscriptions() from public;
grant execute on function public.register_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.unregister_push_subscription(text) to authenticated;
grant execute on function public.my_push_subscriptions() to authenticated;

/* ---- Fan-out to a set of roles ----------------------------------------- */

/*
   notify_user() (0040) reaches one person. Handler alerts need a group, and
   the group differs per event — §10 is explicit that not every role should
   receive everything. The caller names the roles; this resolves them to
   people and writes one row each.

   One row per RECIPIENT is not a duplicate: it is the same event addressed to
   different people, and each of them reads and dismisses it independently.
*/
create or replace function public.notify_roles(
  p_roles      text[],
  p_type       text,
  p_title      text,
  p_message    text,
  p_related_id text default null,
  p_exclude    uuid default null
) returns integer language plpgsql security definer set search_path = public as $$
declare
  v_n integer := 0;
begin
  insert into public.notifications (user_id, type, title, message, related_id)
  select p.id, p_type, p_title, p_message, p_related_id
    from public.profiles p
   where p.role = any (p_roles)
     and (p_exclude is null or p.id <> p_exclude);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.notify_roles(text[], text, text, text, text, uuid) from public;

/* ---- Handler alert: a new order --------------------------------------- */

create or replace function public.notify_new_order()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  /* Everyone who processes orders. Staff included: taking a new order is the
     job. Deliberately NOT the customer — they are looking at the confirmation
     screen at this exact moment.

     Wrapped, because this trigger runs INSIDE create_checkout_order's
     transaction: if the alert fails, the customer must still get their order.
     A missing staff notification is a nuisance; a lost order is not. */
  perform public.notify_roles(
    array['staff', 'supervisor', 'admin', 'owner'],
    'admin_order',
    'New order',
    /* Money is fine here: every one of these tiers can already read
       orders.total in the Orders list. Nothing about the customer beyond a
       first name goes in. */
    new.code || ' · ' || to_char(new.total, 'FM999G999G999') ||
      ' · ' || case when new.fulfilment = 'pickup' then 'Pickup' else 'Delivery' end,
    new.code,
    new.user_id);
  return new;
exception when others then
  raise warning 'new-order alert failed for %: %', new.code, sqlerrm;
  return new;
end;
$$;

drop trigger if exists orders_notify_new on public.orders;
create trigger orders_notify_new
  after insert on public.orders
  for each row execute function public.notify_new_order();

/* ---- Handler alert: a cancellation ------------------------------------- */

create or replace function public.notify_order_cancelled()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is not distinct from old.status then return new; end if;
  if new.status <> 'Cancelled' then return new; end if;

  /* Supervisor and above: cancelling is their decision to make (0037), so it
     is their event to be told about. Plain staff cannot cancel and do not
     need the alert. */
  perform public.notify_roles(
    array['supervisor', 'admin', 'owner'],
    'admin_order',
    'Order cancelled',
    new.code || ' was cancelled.',
    new.code,
    auth.uid());          -- not the person who just did it
  return new;
exception when others then
  raise warning 'cancellation alert failed for %: %', new.code, sqlerrm;
  return new;
end;
$$;

drop trigger if exists orders_notify_cancelled on public.orders;
create trigger orders_notify_cancelled
  after update on public.orders
  for each row execute function public.notify_order_cancelled();

/* ---- Handler alert: a customer got in touch ---------------------------- */

create or replace function public.notify_staff_customer_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.sender_role <> 'customer' then return new; end if;
  perform public.notify_roles(
    array['staff', 'supervisor', 'admin', 'owner'],
    'admin_support',
    'New customer message',
    /* No message body: this lands on lock screens (§23). */
    'A customer sent a message in Live Chat.',
    new.conversation_id::text,
    null);
  return new;
exception when others then
  raise warning 'staff chat alert failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists chat_messages_notify_staff on public.chat_messages;
create trigger chat_messages_notify_staff
  after insert on public.chat_messages
  for each row execute function public.notify_staff_customer_message();

/* ---- Customer alert: what happened to their payment -------------------- */

/*
   §9: read the payment events that already exist, do not create a second
   payment state. This trigger writes a notification and touches nothing
   else — no order column, no wallet, no Paystack call, no webhook behaviour.
*/
create or replace function public.notify_payment_result()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_user uuid;
  v_code text;
begin
  if new.order_id is null then return new; end if;
  if new.status not in ('success', 'failed') then return new; end if;

  select o.user_id, o.code into v_user, v_code
    from public.orders o where o.id = new.order_id;
  if v_user is null then return new; end if;

  perform public.notify_user(
    v_user, 'payment',
    case when new.status = 'success' then 'Payment received' else 'Payment did not go through' end,
    case when new.status = 'success'
         then 'We have received your payment for ' || v_code || '.'
         else 'Your payment for ' || v_code || ' was not completed.' end,
    new.order_id::text,
    false);
  return new;
exception when others then
  /* This fires inside settle_order_payment(), which the Paystack webhook
     drives. Settlement must never fail because a notification did. */
  raise warning 'payment notification failed for order %: %', new.order_id, sqlerrm;
  return new;
end;
$$;

drop trigger if exists payment_events_notify on public.payment_events;
create trigger payment_events_notify
  after insert on public.payment_events
  for each row execute function public.notify_payment_result();

/* ---- Manual customer notification keeps working ------------------------ */

/* admin_notify_customer() (0040) already routes through notify_user(), so it
   picks the push channel up for free. Nothing to change. */

commit;
