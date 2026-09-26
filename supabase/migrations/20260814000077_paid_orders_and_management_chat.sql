/* ==========================================================================
   Partial-launch stabilisation — paid orders reach the kitchen, and a staff
   member's conversation with management stays with management
   --------------------------------------------------------------------------
   Three changes. Nothing here touches settlement, the Paystack webhook, the
   wallet ledger, refunds, amounts or any payment column.

   1. AN UNPAID ORDER CANNOT BE PROCESSED
      create_checkout_order() inserts every order unpaid, before the customer
      reaches Paystack, so an abandoned checkout is an ordinary row in "New".
      enforce_order_status_tier() checked the ORDER of statuses but never
      whether the food had been paid for, so staff could cook, send out and
      complete an order nobody paid for. It now refuses any move into
      Preparing, Out or Completed while paid = false.

      Cancelling is untouched: an unpaid or abandoned order can still be
      cancelled by a supervisor, admin or owner, exactly as before. The same
      early return for server-side paths (no auth.uid()) is kept.

      Existing unpaid orders that were already advanced before this migration
      keep their status, but can now only be cancelled, not moved forward.

   2. THE KITCHEN ALERT MEANS "A PAID ORDER ARRIVED"
      notify_new_order() ran AFTER INSERT, i.e. before payment, so every
      checkout attempt rang the kitchen. The same function now runs when an
      order BECOMES paid (paid false -> true), whichever path settled it
      (settle_order_payment from the webhook, or pay_order_from_wallet). An
      order inserted already paid — none are today — would alert on insert.

      Exactly once per order, by two independent guards:
        * the transition itself: nothing in this schema ever sets paid back
          to false, and both settlement paths return early for an order that
          is already paid, so a webhook replay or a second wallet call cannot
          produce a second false -> true;
        * an existence check: if an admin_order notification for this order
          code already exists, nothing is written.
      Failure isolation is unchanged: the body is wrapped, so a notification
      error is logged and swallowed and can never roll back the settlement
      that fired it. Same notify_roles() path, same 'admin_order' type the
      sound, the bell and push already understand — no parallel system.

   3. STAFF <-> MANAGEMENT CHAT IS MANAGEMENT-ONLY
      chat_conversations is one thread per person. A customer's thread is
      support; a thread owned by a staff+ account is that team member talking
      to management (the staff-flag "Chat management" button opens it). Every
      read path granted any handler (is_admin(), i.e. staff and up) access to
      every thread, so colleagues could read a flagged team member's
      conversation with management.

      chat_thread_visible(owner) is now the single rule, used by every policy
      and RPC that exposes a thread:
        * the owner always sees their own thread;
        * a thread owned by a customer: any handler, as before;
        * a thread owned by staff or above: admin and owner only.
      Applied to the SELECT/UPDATE policies on chat_conversations, the
      SELECT/INSERT/UPDATE policies on chat_messages (so realtime delivery,
      which follows the SELECT policy, is covered too), admin_chat_inbox(),
      admin_support_unread() and touch_chat_presence().

   ROLLBACK
     Re-apply the previous bodies from 20260814000037 (enforce_order_status_
     tier), 20260814000043 (notify_new_order + the AFTER INSERT trigger),
     20260814000029/30/31 (chat policies), 20260814000041 (admin_chat_inbox,
     admin_support_unread) and 20260814000047 (touch_chat_presence), then
     drop function public.chat_thread_visible(uuid).
   ========================================================================== */

begin;

/* ---- 1. No processing an unpaid order ---------------------------------- */

create or replace function public.enforce_order_status_tier()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_allowed text[];
begin
  if auth.uid() is null then return new; end if;
  if new.status is not distinct from old.status then return new; end if;

  /* Cancelling writes off an order, so it stays above plain staff — but it is
     a floor decision, not a finance one, so supervisor may make it. */
  if new.status = 'Cancelled' and not public.is_supervisor() then
    raise exception 'Only a supervisor, admin or owner may cancel an order'
      using errcode = '42501';
  end if;

  /* The kitchen works on paid orders only. An unpaid order can wait or be
     cancelled; it cannot be prepared, sent out or completed. */
  if new.status in ('Preparing', 'Out', 'Completed') and not coalesce(new.paid, false) then
    raise exception 'Order % is not paid yet and cannot be moved to %', new.code, new.status
      using errcode = '42501',
            hint = 'Wait for the payment to be confirmed, or cancel the order.';
  end if;

  v_allowed := case old.status
                 when 'New'       then array['Preparing', 'Cancelled']
                 when 'Preparing' then array['Out', 'Cancelled']
                 when 'Out'       then array['Completed', 'Cancelled']
                 else array[]::text[]          -- Completed and Cancelled are final
               end;

  if not (new.status = any (v_allowed)) then
    raise exception 'Cannot move an order from % to %', old.status, new.status
      using errcode = '42501',
            hint = 'Orders advance New -> Preparing -> Out -> Completed. '
                   'Completed and Cancelled orders cannot change again.';
  end if;

  return new;
end;
$$;

/* ---- 2. Alert the kitchen when an order is PAID ------------------------ */

create or replace function public.notify_new_order()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  /* Only a paid order is kitchen-ready. On INSERT that is never true today
     (checkout creates orders unpaid); on UPDATE it is the one moment paid
     turns from false to true. */
  if not coalesce(new.paid, false) then return new; end if;
  if tg_op = 'UPDATE' and coalesce(old.paid, false) then return new; end if;

  /* Second guard: one kitchen alert per order, however it got here. */
  if exists (select 1 from public.notifications
              where type = 'admin_order' and related_id = new.code) then
    return new;
  end if;

  /* Everyone who processes orders. Staff included: taking a new order is the
     job. Deliberately NOT the customer — they already have their own
     payment notification.

     Wrapped, because this trigger runs INSIDE the settlement transaction
     (settle_order_payment / pay_order_from_wallet): if the alert fails, the
     payment must still settle. A missing staff notification is a nuisance;
     a lost payment is not. */
  perform public.notify_roles(
    array['staff', 'supervisor', 'admin', 'owner'],
    'admin_order',
    'New paid order',
    /* Money is fine here: every one of these tiers can already read
       orders.total in the Orders list. Nothing about the customer. */
    new.code || ' · ' || to_char(new.total, 'FM999G999G999') ||
      ' · ' || case when new.fulfilment = 'pickup' then 'Pickup' else 'Delivery' end ||
      ' · Paid' || case new.payment_provider
                     when 'wallet'   then ' (wallet)'
                     when 'paystack' then ' (Paystack)'
                     else '' end,
    new.code,
    new.user_id);
  return new;
exception when others then
  raise warning 'new-order alert failed for %: %', new.code, sqlerrm;
  return new;
end;
$$;

/* The duplicate guard above runs inside settlement; keep it an index probe. */
create index if not exists notifications_admin_order_related_idx
  on public.notifications (related_id) where type = 'admin_order';

drop trigger if exists orders_notify_new on public.orders;
create trigger orders_notify_new
  after insert or update of paid on public.orders
  for each row execute function public.notify_new_order();

revoke all on function public.notify_new_order() from public, anon, authenticated;
revoke all on function public.enforce_order_status_tier() from public, anon, authenticated;

/* ---- 3. Management-only staff conversations ----------------------------- */

/*
   May the caller see the chat thread owned by p_owner?
   STABLE + SECURITY DEFINER so a policy can read the owner's role without
   the caller needing (or gaining) profile access. Takes only the owner id,
   and answers only for the caller, so it discloses nothing new: a caller who
   is not a handler gets false for every thread but their own.
*/
create or replace function public.chat_thread_visible(p_owner uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when p_owner is null then false
    when p_owner = auth.uid() then true
    when not public.is_admin() then false
    when public.is_manager() then true
    else coalesce(
      (select public.role_rank(p.role) < public.role_rank('staff')
         from public.profiles p where p.id = p_owner),
      false)
  end;
$$;
revoke all on function public.chat_thread_visible(uuid) from public, anon;
grant execute on function public.chat_thread_visible(uuid) to authenticated, service_role;

drop policy if exists chat_conv_select on public.chat_conversations;
create policy chat_conv_select on public.chat_conversations
  for select to authenticated
  using ((select public.chat_thread_visible(user_id)));

drop policy if exists chat_conv_update on public.chat_conversations;
create policy chat_conv_update on public.chat_conversations
  for update to authenticated
  using ((select public.chat_thread_visible(user_id)))
  with check ((select public.chat_thread_visible(user_id)));

drop policy if exists chat_msg_select on public.chat_messages;
create policy chat_msg_select on public.chat_messages
  for select to authenticated
  using (exists (
    select 1 from public.chat_conversations c
     where c.id = conversation_id
       and public.chat_thread_visible(c.user_id)));

drop policy if exists chat_msg_insert on public.chat_messages;
create policy chat_msg_insert on public.chat_messages
  for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and exists (
      select 1 from public.chat_conversations c
       where c.id = conversation_id
         and public.chat_thread_visible(c.user_id)));

drop policy if exists chat_msg_update on public.chat_messages;
create policy chat_msg_update on public.chat_messages
  for update to authenticated
  using (exists (
    select 1 from public.chat_conversations c
     where c.id = conversation_id
       and public.chat_thread_visible(c.user_id)));

/* The inbox: 0041's body, with the thread rule applied to what is listed,
   counted and summed. Everything else is unchanged. */
create or replace function public.admin_chat_inbox(
  p_search text default '',
  p_filter text default 'all',
  p_limit  integer default 30,
  p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_mgr    boolean := public.is_manager();
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_filter text := coalesce(nullif(btrim(p_filter), ''), 'all');
  v_rows   jsonb;
  v_total  integer;
  v_recent timestamptz := now() - interval '7 days';
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  with base as (
    select c.id, c.user_id, c.status, c.last_message_at, c.created_at,
           c.admin_unread, c.customer_unread,
           nullif(btrim(coalesce(p.display_name, '')), '') as name,
           u.email,
           (select m.body from public.chat_messages m
             where m.conversation_id = c.id
             order by m.created_at desc limit 1) as last_body,
           (select m.sender_role from public.chat_messages m
             where m.conversation_id = c.id
             order by m.created_at desc limit 1) as last_role
      from public.chat_conversations c
      left join public.profiles p on p.id = c.user_id
      left join auth.users u on u.id = c.user_id
     where public.chat_thread_visible(c.user_id)
  ),
  filtered as (
    select b.*, count(*) over () as total
      from base b
     where (v_filter = 'all'
            or (v_filter = 'unread' and b.admin_unread > 0)
            or (v_filter = 'recent' and b.last_message_at >= v_recent))
       and (v_search is null
            or b.name ilike '%' || v_search || '%'
            or (v_mgr and b.email ilike '%' || v_search || '%'))
  ),
  page as (
    select * from filtered
     order by last_message_at desc nulls last, created_at desc
     limit greatest(1, least(coalesce(p_limit, 30), 100))
    offset greatest(0, coalesce(p_offset, 0))
  )
  select coalesce(max(f.total), 0),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', f.id,
           'user_id', f.user_id,
           'name', f.name,
           'email', case when v_mgr then f.email else null end,
           'status', f.status,
           'last_message_at', f.last_message_at,
           'created_at', f.created_at,
           'admin_unread', f.admin_unread,
           'last_body', left(coalesce(f.last_body, ''), 120),
           'last_role', f.last_role)
           order by f.last_message_at desc nulls last, f.created_at desc), '[]'::jsonb)
    into v_total, v_rows
    from page f;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'viewer_role', public.auth_role(),
    'can_see_email', v_mgr,
    'unread_total', (select coalesce(sum(admin_unread), 0) from public.chat_conversations c
                      where public.chat_thread_visible(c.user_id)));
end;
$$;

/* The Support badge: 0041's body, counting only threads the caller may open. */
create or replace function public.admin_support_unread()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'chat_messages', (select coalesce(sum(admin_unread), 0) from public.chat_conversations c
                       where public.chat_thread_visible(c.user_id)),
    'chat_conversations', (select count(*) from public.chat_conversations c
                            where c.admin_unread > 0 and public.chat_thread_visible(c.user_id)),
    'open_tickets', (select count(*) from public.support_tickets where status = 'open'),
    /* Contact messages are supervisor+ (0037), so a staff caller is told
       zero rather than a number they cannot open. */
    'new_contacts', case when public.is_supervisor()
                         then (select count(*) from public.contact_messages where status = 'new')
                         else 0 end,
    'latest_at', (select max(last_message_at) from public.chat_conversations c
                   where public.chat_thread_visible(c.user_id)));
end;
$$;

/* Presence: 0047's body. A handler may only mark themselves present in a
   thread they are allowed to open. */
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

  if v_owner = v_uid then
    /* The person the thread belongs to — customer or staff member. */
    update public.chat_conversations
       set customer_seen_at = now() where id = p_conversation_id;
  elsif public.is_admin() and public.chat_thread_visible(v_owner) then
    update public.chat_conversations
       set admin_seen_at = now() where id = p_conversation_id;
  else
    raise exception 'Not permitted' using errcode = '42501';
  end if;

  return jsonb_build_object('status', 'ok', 'side',
    case when v_owner = v_uid then 'customer' else 'admin' end);
end;
$$;

commit;
