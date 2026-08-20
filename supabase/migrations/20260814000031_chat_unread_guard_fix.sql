-- ---------------------------------------------------------------------------
-- Fix: the unread guard blocked the message trigger it was meant to coexist
-- with.
--
-- 0030 added guard_conversation_unread() to stop a customer clearing the
-- ADMIN unread badge. It bypassed only when auth.uid() IS NULL, on the
-- assumption that server-side writes are unauthenticated.
--
-- chat_message_stamp() breaks that assumption: it runs inside the SENDER's
-- session, so when a customer sent a message the trigger's own
-- `admin_unread = admin_unread + 1` was seen as the customer touching the
-- admin counter, and the guard raised 42501 — every customer message failed
-- with HTTP 403.
--
-- The two cases genuinely need telling apart, so the message trigger now
-- marks its own update with a transaction-local flag and the guard stands
-- down for exactly that write. A direct PATCH from a browser carries no flag
-- and is still refused.
-- ---------------------------------------------------------------------------

create or replace function public.chat_message_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  v_role := public.auth_role();
  if v_role not in ('customer', 'staff', 'admin', 'owner') then
    raise exception 'Sign in to send a message' using errcode = '42501';
  end if;
  new.sender_role := v_role;

  /* Transaction-local: cleared automatically at commit, never leaks between
     statements or sessions. */
  perform set_config('kt.chat_internal', '1', true);

  update public.chat_conversations
     set last_message_at = now(),
         updated_at      = now(),
         admin_unread    = case when v_role = 'customer' then admin_unread + 1 else admin_unread end,
         customer_unread = case when v_role = 'customer' then customer_unread else customer_unread + 1 end
   where id = new.conversation_id;

  perform set_config('kt.chat_internal', '', true);

  return new;
end;
$$;

create or replace function public.guard_conversation_unread()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  /* The message trigger's own bookkeeping. */
  if coalesce(current_setting('kt.chat_internal', true), '') = '1' then
    return new;
  end if;

  if auth.uid() is null then return new; end if;

  v_role := public.auth_role();

  if v_role = 'customer' then
    if new.admin_unread is distinct from old.admin_unread then
      raise exception 'You cannot change the admin unread count' using errcode = '42501';
    end if;
    if new.customer_unread > old.customer_unread then
      raise exception 'You cannot raise your own unread count' using errcode = '42501';
    end if;
  else
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
