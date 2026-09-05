/* ==========================================================================
   Email as a third delivery channel
   --------------------------------------------------------------------------
   Phase 14 reserved notifications.email_sent_at and wrote
   notification_channels(), which has said since then that `order` and
   `payment` are email-eligible and that admin_* rows are not. Nothing has
   ever written that column. This connects it, using the same shape
   dispatch_push() already uses: one row in public.notifications, fanned out
   to whichever channels apply.

   NO NEW EVENT SOURCE, AND NO NEW LEDGER

   The business event still produces exactly one notifications row. Email is
   read off that row, so an emailed order update and the bell entry beside it
   can never disagree, and there is nothing to reconcile.

   The brief asked whether a delivery ledger was needed. It already exists:
   notification_id + channel uniqueness is expressed as one stamp column per
   channel on the notification row itself — push_sent_at, email_sent_at,
   whatsapp_sent_at. A separate table would be a second copy of a fact the
   row already holds. Two small columns are added for the failure half of the
   story, which the stamp alone cannot express.

   NOT CONFIGURED YET, AND THAT IS A WORKING STATE

   There is no Resend account, API key or verified domain in this project —
   the audit found no provider code, no secret and no template anywhere. Like
   dispatch_push() before its secrets were set, this dispatcher returns
   quietly when it finds no configuration. The in-app notification and the
   push still stand on their own; email simply does not happen yet.
   ========================================================================== */

begin;

/* ---- The failure half of the ledger ------------------------------------ */

/*
   email_sent_at alone says "sent" or "not yet", which cannot distinguish
   "never attempted" from "attempted four times and Resend keeps refusing".
   A retry needs to know the difference, and so does anyone asked why a
   customer never got their receipt.
*/
alter table public.notifications
  add column if not exists email_attempts smallint not null default 0,
  add column if not exists email_error    text;

comment on column public.notifications.email_attempts is
  'How many times email delivery has been tried for this notification. '
  'Bounded retry: the dispatcher gives up after EMAIL_MAX_ATTEMPTS.';
comment on column public.notifications.email_error is
  'Last delivery failure, for diagnosis. Never shown to a customer.';

/* ---- Who wants email --------------------------------------------------- */

/*
   Mirrors wants_push() exactly, including its rule that a preference may
   silence a promotion but not "your order was cancelled".

   The preference read is notification_preferences.email_orders, which has
   existed since 0043 and defaults to true. No new preference table, and no
   new opt-out: a customer who has never touched their settings keeps
   receiving transactional order mail, which is what a transactional channel
   is for.
*/
create or replace function public.wants_email(p_user_id uuid, p_type text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
           /* Cancellations and payment results are not marketing. */
           when public.notification_is_critical(p_type) then true
           else coalesce(
             (select p.email_orders
                from public.notification_preferences p
               where p.user_id = p_user_id),
             true)
         end;
$$;

revoke all on function public.wants_email(uuid, text) from public, anon, authenticated;

/* ---- Is this row emailable at all? ------------------------------------- */

/*
   One place that decides, so the trigger and the Edge Function cannot drift.
   Four conditions, each doing real work:

     channel      notification_channels() must list 'email'. That is what
                  keeps admin_order/admin_support/admin_ticket internal —
                  a handler alert must never become customer mail.
     preference   wants_email(), above.
     recipient    the account must actually have an email address. A
                  phone-only signup has nothing to send to.
     not sent     email_sent_at is null, and attempts are under the cap.
*/
create or replace function public.email_is_eligible(p_notification_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.notifications n
      join auth.users u on u.id = n.user_id
     where n.id = p_notification_id
       and n.email_sent_at is null
       and n.email_attempts < 5
       and 'email' = any (public.notification_channels(n.type))
       and public.wants_email(n.user_id, n.type)
       and coalesce(btrim(u.email), '') <> ''
  );
$$;

revoke all on function public.email_is_eligible(uuid) from public, anon, authenticated;

/* ---- Where the sender lives -------------------------------------------- */

/*
   The URL only. The dispatch secret is written by the deploy step, exactly
   as 0044 does for push — there is no secret literal in this repository and
   this migration creates none.
*/
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'email_send_url') then
    perform vault.create_secret(
      'https://opnddlqzdetysqozafko.supabase.co/functions/v1/email-send',
      'email_send_url',
      'Edge Function that sends a notification as email through Resend');
  end if;
end $$;

/* ---- The dispatcher ---------------------------------------------------- */

create or replace function public.dispatch_email()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_url    text;
  v_secret text;
begin
  if new.email_sent_at is not null then return new; end if;

  /* Decided here so the Edge Function is never woken for a row it would only
     refuse — and decided again there, because a queued request is not a
     trustworthy statement about eligibility. */
  if not public.email_is_eligible(new.id) then return new; end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'email_send_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'email_dispatch_secret';

  /* Email not configured: the notification and the push still stand. This is
     the state the project is in until a Resend key exists, and it is a
     working state rather than a broken one. */
  if v_url is null or v_secret is null then return new; end if;

  /* net.http_post QUEUES; it does not send. The trigger runs inside the
     transaction that produced the notification — for a new order that is
     create_checkout_order() — so a synchronous call would put a customer's
     checkout behind a round trip to Resend. pg_net's worker sends after the
     commit, which also means no email is sent for an order that rolls back.
     This is what keeps Part I's promise that email cannot break checkout. */
  perform net.http_post(
    url     := v_url,
    body    := jsonb_build_object('notification_id', new.id),
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-dispatch-secret', v_secret),
    timeout_milliseconds := 8000);

  return new;
exception when others then
  /* A delivery channel must never cost the event itself. */
  raise warning 'email dispatch failed for notification %: %', new.id, sqlerrm;
  return new;
end;
$$;

/*
   AFTER INSERT only, like push. A collapsed repeat updates the row rather
   than inserting, and deliberately does not send a second email.
*/
drop trigger if exists notifications_dispatch_email on public.notifications;
create trigger notifications_dispatch_email
  after insert on public.notifications
  for each row execute function public.dispatch_email();

/* ---- What the sender is allowed to read -------------------------------- */

/*
   The Edge Function asks for exactly the fields an email needs, by
   notification id, and gets nothing else. In particular it never receives a
   recipient address from its caller — it looks the address up here from the
   account that owns the notification, so a forged request cannot redirect
   somebody's order mail to an attacker's inbox.

   Everything returned is already the customer's own: their name, their order,
   their status. No staff identity, no internal note, no audit row.
*/
create or replace function public.email_payload(p_notification_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_row jsonb;
begin
  select jsonb_build_object(
           'notification_id', n.id,
           'type',            n.type,
           'title',           n.title,
           'message',         n.message,
           'created_at',      n.created_at,
           'to_email',        u.email,
           'to_name',         nullif(btrim(coalesce(p.display_name, '')), ''),
           'order', case when o.id is null then null else jsonb_build_object(
             'code',       o.code,
             'status',     o.status,
             'fulfilment', o.fulfilment,
             'total',      o.total,
             'paid',       o.paid) end)
    into v_row
    from public.notifications n
    join auth.users u      on u.id = n.user_id
    left join public.profiles p on p.id = n.user_id
    /* related_id carries the order UUID for `order` rows — see
       notify_order_status(). Joined defensively so a non-uuid related_id on
       some other type cannot raise. */
    left join public.orders o
           on n.type in ('order', 'payment')
          and o.id::text = n.related_id
          and o.user_id = n.user_id     /* never another customer's order */
   where n.id = p_notification_id;

  return v_row;
end;
$$;

revoke all on function public.email_payload(uuid) from public, anon, authenticated;

commit;
