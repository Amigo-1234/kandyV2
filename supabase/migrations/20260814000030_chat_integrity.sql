-- ---------------------------------------------------------------------------
-- Chat integrity hardening.
--
-- 0029 got the important part right: chat_message_stamp() overwrites
-- sender_role with auth_role() on every insert, so a client-supplied role is
-- discarded no matter what it claims. Two smaller holes remain.
--
-- 1. sender_role is still in the INSERT column grant. The trigger clobbers it,
--    so this is not exploitable — but a column a client may write and the
--    server always overwrites is a trap for the next person reading the
--    policy. Removing the grant makes the intent unambiguous.
--
-- 2. chat_conversations UPDATE grants both unread counters to anyone who
--    passes the row check, and the row check includes the CUSTOMER. So a
--    customer could zero admin_unread and make their own message look already
--    read to staff. Each side may now only clear its OWN counter.
-- ---------------------------------------------------------------------------

revoke insert (sender_role) on public.chat_messages from authenticated;

create or replace function public.guard_conversation_unread()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  /* Server-side callers (service_role, migrations, the message trigger's own
     update) are trusted and must not be constrained here. */
  if auth.uid() is null then return new; end if;

  v_role := public.auth_role();

  if v_role = 'customer' then
    /* A customer may clear their own badge, never the other side's, and may
       never inflate either. */
    if new.admin_unread is distinct from old.admin_unread then
      raise exception 'You cannot change the admin unread count'
        using errcode = '42501';
    end if;
    if new.customer_unread > old.customer_unread then
      raise exception 'You cannot raise your own unread count'
        using errcode = '42501';
    end if;
  else
    if new.customer_unread is distinct from old.customer_unread then
      raise exception 'Staff cannot change the customer unread count'
        using errcode = '42501';
    end if;
    if new.admin_unread > old.admin_unread then
      raise exception 'Staff cannot raise the admin unread count'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists chat_conversations_unread_guard on public.chat_conversations;
create trigger chat_conversations_unread_guard
  before update of customer_unread, admin_unread on public.chat_conversations
  for each row execute function public.guard_conversation_unread();

comment on function public.guard_conversation_unread is
  'Each side may only clear its own unread counter, never the other side''s, and never inflate one.';
