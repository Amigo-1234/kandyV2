/* ==========================================================================
   Phase 11 (4/4) — the notification relationship
   --------------------------------------------------------------------------
   public.notifications has existed since 0001, is already in the
   supabase_realtime publication, and contained zero rows: nothing had ever
   written to it. This migration makes it the single channel through which the
   kitchen reaches a customer, and it does so entirely server-side.

   WHY NO BROWSER CAN FORGE ONE
   ----------------------------
   `authenticated` holds SELECT, DELETE and a column-level UPDATE(read,
   read_at) on notifications — and NO INSERT grant at all. That is not an
   oversight to be fixed; it is the design. A notification therefore cannot be
   created by any PostgREST request from any tier, only by the SECURITY
   DEFINER paths below. There is no policy to get wrong because there is no
   verb to police.

   Marking one read is already safe for the same reason from the other side:
   the UPDATE policy is `user_id = auth.uid()` in both USING and WITH CHECK,
   so another customer's row is not visible to the statement, and the only
   columns that can be written are the two boolean-ish ones. Title, message,
   type, related_id and user_id are unwritable by anyone with a browser, so a
   notification cannot be re-pointed at someone else or given a false sender.

   ONE TIGHTENING
   --------------
   notifications_select_own admitted is_admin(), which after 0037 would have
   meant every staff member and supervisor could read every customer's
   personal notifications. Nothing in the admin app reads this table. It
   becomes is_manager(), the same treatment addresses got in 0028.

   COLLAPSING
   ----------
   A staff member firing six chat messages should ring the bell once, not six
   times. notify_user(..., p_collapse => true) refreshes the existing UNREAD
   notification for that conversation instead of stacking a new one, so the
   badge stays honest and the text stays current. The realtime publication
   carries updates as well as inserts, so the customer still sees it land.
   ========================================================================== */

begin;

/* ---- Personal notifications are personal ------------------------------- */

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select to authenticated
  using ((user_id = (select auth.uid())) or (select public.is_manager()));

/* ---- The one way a notification is born -------------------------------- */

create or replace function public.notify_user(
  p_user_id    uuid,
  p_type       text,
  p_title      text,
  p_message    text,
  p_related_id text default null,
  p_collapse   boolean default false
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if p_user_id is null then return null; end if;

  if p_collapse and p_related_id is not null then
    update public.notifications
       set title      = p_title,
           message    = p_message,
           created_at = now()
     where user_id = p_user_id
       and type = p_type
       and related_id = p_related_id
       and read = false
    returning id into v_id;
    if v_id is not null then return v_id; end if;
  end if;

  insert into public.notifications (user_id, type, title, message, related_id)
  values (p_user_id, p_type, p_title, p_message, p_related_id)
  returning id into v_id;
  return v_id;
end;
$$;

/* Server-side only. No browser role may call this directly — if it could, the
   INSERT grant we deliberately withheld would be back through the front
   door. */
revoke all on function public.notify_user(uuid, text, text, text, text, boolean) from public;

/* ---- Live chat: a staff reply reaches the customer --------------------- */

create or replace function public.notify_chat_reply()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
begin
  /* sender_role is stamped from the JWT by chat_message_stamp(), so this
     cannot be flipped by the sender. */
  if new.sender_role = 'customer' then return new; end if;

  select user_id into v_owner
    from public.chat_conversations where id = new.conversation_id;
  if v_owner is null or v_owner = new.sender_id then return new; end if;

  perform public.notify_user(
    v_owner, 'chat',
    'Kandy''s Treats replied to your message',
    left(new.body, 140),
    new.conversation_id::text,
    true);
  return new;
end;
$$;

drop trigger if exists chat_messages_notify on public.chat_messages;
create trigger chat_messages_notify
  after insert on public.chat_messages
  for each row execute function public.notify_chat_reply();

/* ---- Support: a staff reply reaches the customer ----------------------- */

create or replace function public.notify_ticket_reply()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner   uuid;
  v_subject text;
begin
  if new.author_role = 'customer' then return new; end if;

  select user_id, subject into v_owner, v_subject
    from public.support_tickets where id = new.ticket_id;
  if v_owner is null or v_owner = new.author_id then return new; end if;

  perform public.notify_user(
    v_owner, 'support',
    'Your support request has been answered',
    coalesce(nullif(btrim(v_subject), ''), 'Support') || ' — ' || left(new.body, 120),
    new.ticket_id::text,
    true);
  return new;
end;
$$;

drop trigger if exists support_ticket_replies_notify on public.support_ticket_replies;
create trigger support_ticket_replies_notify
  after insert on public.support_ticket_replies
  for each row execute function public.notify_ticket_reply();

/* ---- Orders: the status the customer is actually waiting on ------------ */

create or replace function public.notify_order_status()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_msg text;
begin
  if new.status is not distinct from old.status then return new; end if;

  v_msg := case new.status
             when 'Preparing' then 'Your order ' || new.code || ' is being prepared.'
             when 'Out'       then 'Your order ' || new.code || ' is on the way.'
             when 'Completed' then 'Your order ' || new.code || ' has been delivered. Enjoy!'
             when 'Cancelled' then 'Your order ' || new.code || ' was cancelled.'
             else null
           end;
  if v_msg is null then return new; end if;

  /* related_id is the order UUID because that is what the order-detail page
     takes in its ?id= — a code here would produce a dead link. */
  perform public.notify_user(
    new.user_id, 'order', 'Order update', v_msg, new.id::text, false);
  return new;
end;
$$;

drop trigger if exists orders_notify_status on public.orders;
create trigger orders_notify_status
  after update on public.orders
  for each row execute function public.notify_order_status();

/* ---- A deliberate message from the kitchen to one customer ------------- */

create or replace function public.admin_notify_customer(
  p_user_id uuid, p_title text, p_message text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_msg   text := btrim(coalesce(p_message, ''));
  v_id    uuid;
begin
  /* Deliberately manager+, not is_admin(). Chat and ticket replies already
     give staff and supervisors a way to reach a customer inside a
     conversation the customer started. Pushing an unsolicited message is a
     communications decision, so it sits with admin and owner. */
  if not public.is_manager() then
    raise exception 'Sending a customer notification is available to admins and the owner only'
      using errcode = '42501';
  end if;
  if v_title = '' or v_msg = '' then
    raise exception 'A notification needs a title and a message' using errcode = '22023';
  end if;
  if length(v_title) > 120 or length(v_msg) > 500 then
    raise exception 'Keep the title under 120 and the message under 500 characters'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'No such customer' using errcode = 'P0002';
  end if;

  v_id := public.notify_user(p_user_id, 'message', v_title, v_msg, null, false);

  perform public.log_admin_action(
    'customer.notify', 'notifications', v_id::text,
    'Sent a notification to customer ' || p_user_id::text,
    jsonb_build_object('user_id', p_user_id, 'title', v_title));

  return jsonb_build_object('status', 'sent', 'id', v_id);
end;
$$;

revoke all on function public.admin_notify_customer(uuid, text, text) from public;
grant execute on function public.admin_notify_customer(uuid, text, text) to authenticated;

/* ---- The admin side's own unread signal -------------------------------- */

/*
   Reuses the counters that already exist — chat_conversations.admin_unread is
   maintained by chat_message_stamp() and guarded by guard_conversation_unread()
   — rather than introducing a second tally that could disagree with the first.
*/
create or replace function public.admin_support_unread()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'chat_messages', (select coalesce(sum(admin_unread), 0) from public.chat_conversations),
    'chat_conversations', (select count(*) from public.chat_conversations where admin_unread > 0),
    'open_tickets', (select count(*) from public.support_tickets where status = 'open'),
    /* Contact messages are supervisor+ (0037), so a staff caller is told
       zero rather than a number they cannot open. */
    'new_contacts', case when public.is_supervisor()
                         then (select count(*) from public.contact_messages where status = 'new')
                         else 0 end,
    'latest_at', (select max(last_message_at) from public.chat_conversations));
end;
$$;

revoke all on function public.admin_support_unread() from public;
grant execute on function public.admin_support_unread() to authenticated;

/* ---- Realtime ---------------------------------------------------------- */

/* notifications, chat_conversations and chat_messages are already published.
   Tickets and their replies were not, which is why the Support Center could
   only see a new ticket by reloading. Realtime respects RLS, so publishing
   them does not widen who sees what. */
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime'
                    and schemaname = 'public' and tablename = 'support_tickets') then
    alter publication supabase_realtime add table public.support_tickets;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime'
                    and schemaname = 'public' and tablename = 'support_ticket_replies') then
    alter publication supabase_realtime add table public.support_ticket_replies;
  end if;
end $$;

commit;
