/* ==========================================================================
   Phase 14 — orchestration around the existing pipeline
   --------------------------------------------------------------------------
   Phase 13's pipeline is live and working: one notifications row per
   (recipient, event), fanned out to the bell, the realtime badge and Web
   Push. Nothing here replaces any of that. Four things are added:

     1. CHANNEL READINESS   email and WhatsApp get their own delivery stamps
                            alongside push_sent_at, so a future channel
                            consumes the SAME row rather than writing its own.

     2. CRITICAL vs OPTIONAL  a preference may silence a promotion; it may not
                            silence "your order was cancelled".

     3. PRESENCE            if the recipient is demonstrably looking at the
                            conversation right now, the reply is not also a
                            notification. §7.

     4. TICKETS BOTH WAYS   a customer raising or replying to a ticket now
                            reaches the operational roles, which was the one
                            direction Phase 13 left out.
   ========================================================================== */

begin;

/* ---- 1. One row, several channels -------------------------------------- */

/*
   push_sent_at already existed. These two are its siblings and are written by
   nobody today — that is the point. When an email provider or a WhatsApp
   Business number exists, its sender claims the row the same way push-send
   does (a conditional UPDATE on a null stamp) and gets the same idempotency
   for free. No second notification record, ever.
*/
alter table public.notifications
  add column if not exists email_sent_at    timestamptz,
  add column if not exists whatsapp_sent_at timestamptz;

comment on column public.notifications.email_sent_at is
  'Reserved for a future email channel. Null and never written today — no '
  'email provider is configured. Same claim-the-null-stamp idempotency as push.';
comment on column public.notifications.whatsapp_sent_at is
  'Reserved for a future WhatsApp Business channel. Null and never written '
  'today — no provider credentials exist.';

/** Which channels a type is eligible for. One place, so a new channel is a
    one-line change rather than a hunt through triggers. */
create or replace function public.notification_channels(p_type text)
returns text[] language sql immutable as $$
  select case
           /* Handler alerts are operational: in-app and push. Emailing a
              kitchen about every order would be noise, not service. */
           when p_type in ('admin_order', 'admin_support', 'admin_ticket') then array['in_app', 'push']
           /* Everything customer-facing is email-eligible the day a provider
              exists. WhatsApp is listed only where a template would plausibly
              be approved: transactional order and payment updates. */
           when p_type in ('order', 'payment')             then array['in_app', 'push', 'email', 'whatsapp']
           when p_type in ('chat', 'support')              then array['in_app', 'push', 'email']
           else                                                 array['in_app', 'push']
         end;
$$;

/* ---- 2. Critical versus optional --------------------------------------- */

/*
   §13. A preference switch is a courtesy, not a licence to miss the thing you
   actually needed to know. Cancellations, payment results and new-order
   alerts stay on regardless; promotions and chatter do not.
*/
create or replace function public.notification_is_critical(p_type text)
returns boolean language sql immutable as $$
  select p_type in ('order', 'payment', 'admin_order');
$$;

/*
   wants_push() gains that rule. Rewritten rather than wrapped so there is
   still exactly one function the Edge Function asks.
*/
create or replace function public.wants_push(p_user_id uuid, p_type text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
           when public.notification_is_critical(p_type) then true
           else coalesce(
             (select case
                       when p_type in ('chat', 'support', 'admin_support', 'admin_ticket') then p.push_support
                       else p.push_marketing
                     end
                from public.notification_preferences p
               where p.user_id = p_user_id),
             true)
         end;
$$;

revoke all on function public.wants_push(uuid, text) from public, anon, authenticated;
revoke all on function public.notification_channels(text) from public, anon, authenticated;
revoke all on function public.notification_is_critical(text) from public, anon, authenticated;
grant execute on function public.notification_is_critical(text) to authenticated;

/* ---- 3. Presence: do not notify someone who is already looking ---------- */

alter table public.chat_conversations
  add column if not exists customer_seen_at timestamptz,
  add column if not exists admin_seen_at    timestamptz;

/*
   Stamped by whoever has the thread open, on their own side only. The role
   decides which column is touched, so a customer cannot mark the admin as
   present (which would suppress the handler's alert) and vice versa.
*/
create or replace function public.touch_chat_presence(p_conversation_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_role text := public.auth_role();
  v_owner uuid;
begin
  if v_uid is null then
    raise exception 'Sign in first' using errcode = '28000';
  end if;

  select user_id into v_owner
    from public.chat_conversations where id = p_conversation_id;
  if v_owner is null then
    raise exception 'No such conversation' using errcode = 'P0002';
  end if;

  if v_role = 'customer' then
    /* A customer may only claim presence in their OWN conversation. */
    if v_owner <> v_uid then
      raise exception 'Not your conversation' using errcode = '42501';
    end if;
    update public.chat_conversations
       set customer_seen_at = now() where id = p_conversation_id;
  elsif public.is_admin() then
    update public.chat_conversations
       set admin_seen_at = now() where id = p_conversation_id;
  else
    raise exception 'Not permitted' using errcode = '42501';
  end if;

  return jsonb_build_object('status', 'ok', 'side',
    case when v_role = 'customer' then 'customer' else 'admin' end);
end;
$$;

revoke all on function public.touch_chat_presence(uuid) from public, anon;
grant execute on function public.touch_chat_presence(uuid) to authenticated;

/* How recently counts as "watching this right now". Long enough to cover the
   gap between heartbeats, short enough that a closed tab stops counting. */
create or replace function public.kt_presence_window()
returns interval language sql immutable as $$ select interval '45 seconds'; $$;

revoke all on function public.kt_presence_window() from public, anon, authenticated;

/* ---- Chat: staff reply reaches the customer, unless they are watching --- */

create or replace function public.notify_chat_reply()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_seen  timestamptz;
begin
  if new.sender_role = 'customer' then return new; end if;

  select user_id, customer_seen_at into v_owner, v_seen
    from public.chat_conversations where id = new.conversation_id;
  if v_owner is null or v_owner = new.sender_id then return new; end if;

  /* §7: they are reading this thread as it arrives. The message itself
     already reached them over realtime; a notification and a buzzing phone
     on top of it is noise about something they are looking at. */
  if v_seen is not null and v_seen > now() - public.kt_presence_window() then
    return new;
  end if;

  perform public.notify_user(
    v_owner, 'chat',
    'Kandy''s Treats replied to your message',
    left(new.body, 140),
    new.conversation_id::text,
    true);
  return new;
exception when others then
  raise warning 'chat notification failed: %', sqlerrm;
  return new;
end;
$$;

/* ---- Chat: customer message reaches the handlers, same rule ------------- */

create or replace function public.notify_staff_customer_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_seen timestamptz;
begin
  if new.sender_role <> 'customer' then return new; end if;

  select admin_seen_at into v_seen
    from public.chat_conversations where id = new.conversation_id;

  /* A handler with this exact conversation open sees the message land in the
     inbox. Alerting them about it is telling them what they can already
     read. Other handlers are NOT suppressed — presence is per conversation,
     and this is the only signal the database has. */
  if v_seen is not null and v_seen > now() - public.kt_presence_window() then
    return new;
  end if;

  perform public.notify_roles(
    array['staff', 'supervisor', 'admin', 'owner'],
    'admin_support',
    'New customer message',
    'A customer sent a message in Live Chat.',
    new.conversation_id::text,
    null);
  return new;
exception when others then
  raise warning 'staff chat alert failed: %', sqlerrm;
  return new;
end;
$$;

/* ---- 4. Tickets, the direction Phase 13 left out ----------------------- */

create or replace function public.notify_staff_new_ticket()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.notify_roles(
    array['staff', 'supervisor', 'admin', 'owner'],
    /* admin_ticket, NOT admin_support: both carry a related_id, but one is a
       conversation and one is a ticket. Sharing a type meant the centre could
       not tell them apart and sent ticket alerts to ?tab=chat&conversation=,
       where the id matches nothing. */
    'admin_ticket',
    'New support request',
    /* The subject is customer-written and lands on lock screens, so it is
       trimmed rather than quoted whole. */
    left(coalesce(nullif(btrim(new.subject), ''), 'Support request'), 80),
    new.id::text,
    new.user_id);
  return new;
exception when others then
  raise warning 'new ticket alert failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists support_tickets_notify_staff on public.support_tickets;
create trigger support_tickets_notify_staff
  after insert on public.support_tickets
  for each row execute function public.notify_staff_new_ticket();

create or replace function public.notify_staff_ticket_reply()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_subject text;
begin
  /* Only the customer's side. A staff reply already notifies the customer
     through notify_ticket_reply(); this is the mirror. */
  if new.author_role <> 'customer' then return new; end if;

  select subject into v_subject from public.support_tickets where id = new.ticket_id;

  perform public.notify_roles(
    array['staff', 'supervisor', 'admin', 'owner'],
    'admin_ticket',
    'Customer replied to a ticket',
    left(coalesce(nullif(btrim(v_subject), ''), 'Support request'), 80),
    new.ticket_id::text,
    new.author_id);
  return new;
exception when others then
  raise warning 'ticket reply alert failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists support_ticket_replies_notify_staff on public.support_ticket_replies;
create trigger support_ticket_replies_notify_staff
  after insert on public.support_ticket_replies
  for each row execute function public.notify_staff_ticket_reply();

/* ---- The admin notification centre's one read -------------------------- */

/*
   Handlers read their OWN admin_* rows — notifications_select_own already
   scopes that to user_id = auth.uid(). This RPC exists for the counts and
   the type filter, so the panel does not pull the whole table to work them
   out.
*/
create or replace function public.admin_notifications(
  p_limit integer default 20, p_unread_only boolean default false
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_rows jsonb;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', n.id, 'type', n.type, 'title', n.title, 'message', n.message,
           'related_id', n.related_id, 'read', n.read, 'created_at', n.created_at)
         order by n.created_at desc), '[]'::jsonb)
    into v_rows
    from (select * from public.notifications
           where user_id = v_uid
             and type in ('admin_order', 'admin_support', 'admin_ticket', 'payment', 'message')
             and (not p_unread_only or read = false)
           order by created_at desc
           limit greatest(1, least(coalesce(p_limit, 20), 50))) n;

  return jsonb_build_object(
    'rows', v_rows,
    'unread', (select count(*) from public.notifications
                where user_id = v_uid and read = false
                  and type in ('admin_order', 'admin_support', 'admin_ticket', 'payment', 'message')),
    'unread_orders', (select count(*) from public.notifications
                       where user_id = v_uid and read = false and type = 'admin_order'),
    'viewer_role', public.auth_role());
end;
$$;

revoke all on function public.admin_notifications(integer, boolean) from public, anon;
grant execute on function public.admin_notifications(integer, boolean) to authenticated;

commit;
