-- ---------------------------------------------------------------------------
-- Support Center
--
-- Existing status vocabularies are reused verbatim, NOT replaced:
--   support_tickets.status   open | answered | closed
--   contact_messages.status  new  | read     | answered
-- The phase brief suggested a five-state ticket flow; inventing it would have
-- meant a second status system alongside the one already in the schema and in
-- the customer's account page.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Ticket replies.
--
-- Tickets had subject + message + status and no way to answer them, so
-- "answered" was a claim with nothing behind it. This is a new capability,
-- not a duplicate of anything.
--
-- author_role is server-derived exactly like chat_messages.sender_role: the
-- trigger overwrites whatever arrives, so a customer cannot post a reply that
-- renders as staff.
-- ---------------------------------------------------------------------------
create table if not exists public.support_ticket_replies (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid not null references public.support_tickets (id) on delete cascade,
  author_id   uuid references public.profiles (id) on delete set null,
  author_role text not null default 'customer'
                check (author_role in ('customer','staff','admin','owner')),
  body        text not null check (btrim(body) <> ''),
  created_at  timestamptz not null default now()
);

create index if not exists support_ticket_replies_ticket_idx
  on public.support_ticket_replies (ticket_id, created_at);

alter table public.support_ticket_replies enable row level security;

revoke all on public.support_ticket_replies from anon, authenticated;
grant select on public.support_ticket_replies to authenticated;
/* author_role is deliberately absent: the trigger sets it. */
grant insert (ticket_id, author_id, body) on public.support_ticket_replies to authenticated;

/* Read a reply if you can read its ticket — the same rule, expressed once. */
create policy support_ticket_replies_select on public.support_ticket_replies
  for select to authenticated
  using (exists (
    select 1 from public.support_tickets t
     where t.id = support_ticket_replies.ticket_id
       and (t.user_id = (select auth.uid()) or (select public.is_admin()))
  ));

create policy support_ticket_replies_insert on public.support_ticket_replies
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and exists (
      select 1 from public.support_tickets t
       where t.id = support_ticket_replies.ticket_id
         and (t.user_id = (select auth.uid()) or (select public.is_admin()))
    )
  );

create or replace function public.support_reply_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  v_role := public.auth_role();
  if v_role not in ('customer','staff','admin','owner') then
    raise exception 'Sign in to reply' using errcode = '42501';
  end if;
  new.author_role := v_role;

  update public.support_tickets
     set updated_at = now(),
         /* A staff answer moves an open ticket to answered. A customer reply
            reopens an answered one. Closed stays closed until reopened by a
            human decision. */
         status = case
                    when v_role <> 'customer' and status = 'open'     then 'answered'
                    when v_role =  'customer' and status = 'answered' then 'open'
                    else status
                  end
   where id = new.ticket_id;

  if v_role <> 'customer' then
    perform public.log_admin_action('support.ticket_reply', 'support_tickets',
      new.ticket_id::text, 'Replied to support ticket',
      jsonb_build_object('length', length(new.body)));
  end if;
  return new;
end;
$$;

drop trigger if exists support_ticket_replies_stamp on public.support_ticket_replies;
create trigger support_ticket_replies_stamp
  before insert on public.support_ticket_replies
  for each row execute function public.support_reply_stamp();

-- ---------------------------------------------------------------------------
-- 2. contact_messages: a record of what a customer actually said.
--
-- The UPDATE grant covered every column, so a manager could rewrite the
-- message body, the sender's name or their phone number. Only the workflow
-- status should ever change after submission.
-- ---------------------------------------------------------------------------
revoke update on public.contact_messages from authenticated;
grant update (status) on public.contact_messages to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Audit. Triggers rather than RPCs: they cannot be sidestepped by talking
--    to PostgREST directly, which an RPC-only approach can be.
-- ---------------------------------------------------------------------------
create or replace function public.audit_ticket_status_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status and auth.uid() is not null
     and public.is_admin() then
    perform public.log_admin_action('support.ticket_status_change', 'support_tickets',
      new.id::text, 'Ticket ' || old.status || ' -> ' || new.status,
      jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return new;
end;
$$;

drop trigger if exists support_tickets_status_audit on public.support_tickets;
create trigger support_tickets_status_audit
  after update of status on public.support_tickets
  for each row execute function public.audit_ticket_status_change();

create or replace function public.audit_contact_status_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status and auth.uid() is not null then
    perform public.log_admin_action('support.contact_read', 'contact_messages',
      new.id::text, 'Contact message ' || old.status || ' -> ' || new.status,
      jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return new;
end;
$$;

drop trigger if exists contact_messages_status_audit on public.contact_messages;
create trigger contact_messages_status_audit
  after update of status on public.contact_messages
  for each row execute function public.audit_contact_status_change();

/* Staff replies in Live Chat are administrative activity; customer messages
   are not, and logging those would turn the audit trail into a message copy. */
create or replace function public.audit_chat_staff_reply()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.sender_role <> 'customer' then
    perform public.log_admin_action('support.chat_reply', 'chat_conversations',
      new.conversation_id::text, 'Replied in live chat',
      jsonb_build_object('length', length(new.body)));
  end if;
  return new;
end;
$$;

drop trigger if exists chat_messages_staff_audit on public.chat_messages;
create trigger chat_messages_staff_audit
  after insert on public.chat_messages
  for each row execute function public.audit_chat_staff_reply();
