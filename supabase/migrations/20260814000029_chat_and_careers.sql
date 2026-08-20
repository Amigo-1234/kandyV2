-- ---------------------------------------------------------------------------
-- In-site live chat + job applications
--
-- Both are customer-facing intake. Neither touches payments, wallets, orders,
-- the menu or any existing policy.
--
-- Chat reuses the SAME Supabase auth and the SAME realtime publication the
-- storefront already uses for orders — there is no second auth system and no
-- second realtime system.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- One conversation per customer. Staff+ see them all; a customer sees only
-- their own, enforced by RLS rather than by which screen they are on.
-- ---------------------------------------------------------------------------
create table if not exists public.chat_conversations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null unique references public.profiles (id) on delete cascade,
  status          text not null default 'open' check (status in ('open', 'closed')),
  last_message_at timestamptz not null default now(),
  customer_unread integer not null default 0 check (customer_unread >= 0),
  admin_unread    integer not null default 0 check (admin_unread >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists chat_conversations_recent_idx
  on public.chat_conversations (last_message_at desc);

create table if not exists public.chat_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations (id) on delete cascade,
  sender_id       uuid references public.profiles (id) on delete set null,
  sender_role     text not null check (sender_role in ('customer', 'staff', 'admin', 'owner')),
  body            text not null check (btrim(body) <> '' and length(body) <= 2000),
  read_at         timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists chat_messages_thread_idx
  on public.chat_messages (conversation_id, created_at);

alter table public.chat_conversations enable row level security;
alter table public.chat_messages      enable row level security;

revoke all on public.chat_conversations from anon, authenticated;
revoke all on public.chat_messages      from anon, authenticated;

grant select, insert on public.chat_conversations to authenticated;
grant update (status, customer_unread, admin_unread, last_message_at, updated_at)
  on public.chat_conversations to authenticated;
grant select, insert on public.chat_messages to authenticated;
grant update (read_at) on public.chat_messages to authenticated;

create policy chat_conv_select on public.chat_conversations
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

create policy chat_conv_insert on public.chat_conversations
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy chat_conv_update on public.chat_conversations
  for update to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()))
  with check (user_id = (select auth.uid()) or (select public.is_admin()));

create policy chat_msg_select on public.chat_messages
  for select to authenticated
  using (exists (
    select 1 from public.chat_conversations c
     where c.id = conversation_id
       and (c.user_id = (select auth.uid()) or (select public.is_admin()))));

/* A customer may only post into their own thread, and only as themselves.
   sender_role is pinned to the caller's real tier by the trigger below, so it
   cannot be spoofed to make a customer message look like staff. */
create policy chat_msg_insert on public.chat_messages
  for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and exists (
      select 1 from public.chat_conversations c
       where c.id = conversation_id
         and (c.user_id = (select auth.uid()) or (select public.is_admin()))));

create policy chat_msg_update on public.chat_messages
  for update to authenticated
  using (exists (
    select 1 from public.chat_conversations c
     where c.id = conversation_id
       and (c.user_id = (select auth.uid()) or (select public.is_admin()))));

/* Stamp the sender's true role and keep the thread summary current. Doing this
   in a trigger means the client cannot claim a role it does not hold. */
create or replace function public.chat_message_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_role text; v_owner uuid;
begin
  v_role := public.auth_role();
  if v_role not in ('customer', 'staff', 'admin', 'owner') then
    raise exception 'Sign in to send a message' using errcode = '42501';
  end if;
  new.sender_role := v_role;

  select user_id into v_owner from public.chat_conversations where id = new.conversation_id;

  update public.chat_conversations
     set last_message_at = now(),
         updated_at      = now(),
         /* Unread accrues on the side that did NOT send. */
         admin_unread    = case when v_role = 'customer' then admin_unread + 1 else admin_unread end,
         customer_unread = case when v_role = 'customer' then customer_unread else customer_unread + 1 end
   where id = new.conversation_id;

  return new;
end;
$$;

drop trigger if exists chat_messages_stamp on public.chat_messages;
create trigger chat_messages_stamp
  before insert on public.chat_messages
  for each row execute function public.chat_message_stamp();

/* Same realtime publication the storefront already subscribes to. */
alter publication supabase_realtime add table public.chat_messages;
alter publication supabase_realtime add table public.chat_conversations;

-- ---------------------------------------------------------------------------
-- Job applications — public intake, exactly like contact_messages.
-- ---------------------------------------------------------------------------
create table if not exists public.job_applications (
  id         uuid primary key default gen_random_uuid(),
  role_slug  text not null check (role_slug in ('chef', 'rider', 'kitchen-assistant')),
  name       text not null check (btrim(name) <> ''),
  phone      text not null check (btrim(phone) <> ''),
  email      text,
  about      text not null default '',
  status     text not null default 'new' check (status in ('new', 'reviewing', 'closed')),
  created_at timestamptz not null default now()
);

alter table public.job_applications enable row level security;
revoke all on public.job_applications from anon, authenticated;
grant insert on public.job_applications to anon, authenticated;
grant select on public.job_applications to authenticated;

create policy job_applications_public_insert on public.job_applications
  for insert to anon, authenticated
  with check (status = 'new');

create policy job_applications_admin_select on public.job_applications
  for select to authenticated
  using ((select public.is_manager()));
