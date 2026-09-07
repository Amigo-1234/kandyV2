/* ==========================================================================
   Phase 13 (addendum) — a chat thread is routed by whose it is, not by who
   happens to be typing
   --------------------------------------------------------------------------
   THE BUG
   -------
   chat_message_stamp() decided whether a message was inbound or outbound
   from auth_role() alone:

       admin_unread    = case when v_role = 'customer' then admin_unread + 1 ...
       customer_unread = case when v_role = 'customer' then customer_unread ...

   That reads correctly for the only case it was written for — a customer
   writes, handlers are alerted; a handler replies, the customer is alerted.
   It is wrong the moment a member of staff writes in THEIR OWN thread, which
   is exactly what the staff-flag "Chat management" button asks them to do:

     * admin_unread is NOT incremented, so the Support badge never lights and
       the thread never surfaces as needing a reply — management never learns
       the message exists;
     * customer_unread IS incremented, so the staff member is notified about
       a message they just sent themselves.

   notify_chat_reply() has the same shape and the same flaw: it skips on
   sender_role = 'customer', so a staff member's own message falls through to
   the reply branch, where it is discarded only because the recipient and the
   sender turn out to be the same person.

   Net effect: a staff member's message to management goes nowhere. The
   staff-flag CTA opened a real conversation into a real table and nobody was
   ever told.

   THE FIX
   -------
   Route on CONVERSATION OWNERSHIP instead of on global role.

       inbound  := (chat_conversations.user_id = the sender)

   A thread belongs to one person. A message from that person is inbound and
   raises admin_unread, whoever they are; a message from anyone else is a
   handler reply and raises customer_unread. That is one rule instead of a
   role list, and it is right for every combination without naming any of
   them:

     customer in own thread    inbound   admin_unread + 1   (unchanged)
     staff in own thread       inbound   admin_unread + 1   (fixed)
     handler in another thread outbound  customer_unread+1  (unchanged)

   Customer behaviour is bit-for-bit what it was, because a customer is
   always the owner of their own conversation. Nothing is hard-coded to a
   user or a role, so a promotion or demotion changes routing by itself.

   sender_role is still stamped from auth_role() and is untouched. It is the
   audit fact of who spoke, and it stays honest — a staff member's message
   is correctly recorded as having come from staff. What changes is only
   which side of the thread it counts against.

   NO NEW TABLE, NO NEW THREAD, NO SECOND CHAT SYSTEM. Historical messages
   and conversations are not read, rewritten or moved.
   ========================================================================== */

begin;

/* ---- 1. Inbound is decided by the thread, not the tier ----------------- */

create or replace function public.chat_message_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_role  text;
  v_owner uuid;
begin
  v_role := public.auth_role();
  if public.role_rank(v_role) < public.role_rank('customer') then
    raise exception 'Sign in to send a message' using errcode = '42501';
  end if;
  /* Unchanged: the recorded fact of who spoke. */
  new.sender_role := v_role;

  select user_id into v_owner
    from public.chat_conversations where id = new.conversation_id;

  /* Transaction-local: cleared automatically at commit, never leaks between
     statements or sessions. */
  perform set_config('kt.chat_internal', '1', true);

  update public.chat_conversations
     set last_message_at = now(),
         updated_at      = now(),
         /* The owner of the thread is the side asking; everyone else is the
            side answering. A staff member writing to management is asking. */
         admin_unread    = case when v_owner = new.sender_id
                                then admin_unread + 1 else admin_unread end,
         customer_unread = case when v_owner = new.sender_id
                                then customer_unread else customer_unread + 1 end
   where id = new.conversation_id;

  perform set_config('kt.chat_internal', '', true);

  return new;
end;
$$;

/* ---- 2. The reply notification, by the same rule ----------------------- */

create or replace function public.notify_chat_reply()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_seen  timestamptz;
begin
  select user_id, customer_seen_at into v_owner, v_seen
    from public.chat_conversations where id = new.conversation_id;

  /* Only a reply from someone OTHER than the thread's owner is a reply. This
     replaces the old `sender_role = 'customer'` skip, which mistook a staff
     member's own message for an answer to somebody. */
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
end;
$$;

/* ---- 3. Close the hole the new routing would otherwise open ------------ */

/*
   guard_conversation_unread() branched on role too: a customer could not
   touch admin_unread, and everyone else could lower it — correct while only
   customers owned threads, wrong now that a staff member can own one. As
   written, a flagged staff member could zero admin_unread on their own
   thread and hide it from the very people they were told to talk to.

   Same rule as above: the OWNER of a thread may not touch the count that
   summons management, and a non-owner may not touch the count that summons
   the owner. No role list, so it stays correct as roles change.
*/
create or replace function public.guard_conversation_unread()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  /* The message trigger's own bookkeeping. */
  if coalesce(current_setting('kt.chat_internal', true), '') = '1' then
    return new;
  end if;

  if auth.uid() is null then return new; end if;

  if new.user_id = auth.uid() then
    /* The person the thread belongs to. */
    if new.admin_unread is distinct from old.admin_unread then
      raise exception 'You cannot change the admin unread count' using errcode = '42501';
    end if;
    if new.customer_unread > old.customer_unread then
      raise exception 'You cannot raise your own unread count' using errcode = '42501';
    end if;
  else
    /* Somebody handling the thread. */
    if new.customer_unread is distinct from old.customer_unread then
      raise exception 'Staff cannot change the customer unread count' using errcode = '42501';
    end if;
    if new.admin_unread > old.admin_unread then
      raise exception 'Staff cannot raise the admin unread count' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

commit;
