/* ==========================================================================
   Phase 11 (1/4) — the SUPERVISOR tier
   --------------------------------------------------------------------------
   Hierarchy after this migration:

     owner 40  >  admin 30  >  supervisor 25  >  staff 20  >  customer 10

   The rank is deliberately 25, not 21 or 29: it sits midway so a later tier
   can be slotted on either side without renumbering anything that already
   exists in the audit log.

   THE CENTRAL DECISION
   --------------------
   is_admin() is this project's "may reach the admin app at all" predicate —
   staff, admin and owner. Supervisor is added to it, which is what gives the
   tier orders, menu availability, chat, tickets and the customer list for
   free, through policies that already exist. Nothing about the existing three
   tiers changes: no account moves, and no role gains a capability it lacked.

   Widening is_admin() does have a blast radius, so the two places where that
   widening would have been WRONG are corrected here, in the same migration
   that causes them:

     app_settings   'ordering_enabled' was writable by is_admin() — that is,
                    by any staff member. Phase 11 §8 says staff and supervisor
                    get no settings at all, so it becomes is_manager(). This
                    is a TIGHTENING: staff loses a switch that could take the
                    whole store offline.

     profiles       protect_profile_role() reverted a role edit unless the
                    caller was is_admin(). With supervisor folded in that
                    predicate is far too generous for the last line of defence
                    behind the role column, so it becomes is_manager().

   WHAT SUPERVISOR GAINS OVER STAFF
   --------------------------------
   Only two things, and both are operational rather than commercial:

     1. Cancelling an order. enforce_order_status_tier() required is_manager()
        to move an order to Cancelled; it now requires is_supervisor().
     2. Contact messages. Read and triage, previously manager-only because the
        rows carry a phone number — but staff already see customer phone
        numbers through admin_list_customers, so the number is not the secret
        that policy was protecting.

   Everything else a supervisor might have been given is deliberately NOT
   given: finance, reconciliation, wallets, payment events, the audit log,
   addresses, announcements, catalogue deletion, item pricing, settings and
   role management all remain gated on is_manager() or is_owner(), so they
   exclude supervisor without a single extra line of policy.
   ========================================================================== */

begin;

/* ---- 1. The rank ------------------------------------------------------- */

create or replace function public.role_rank(p_role text)
returns integer language sql immutable as $$
  select case p_role
           when 'owner'      then 40
           when 'admin'      then 30
           when 'supervisor' then 25
           when 'staff'      then 20
           when 'customer'   then 10
           else 0
         end;
$$;

/* ---- 2. The role must be storable before anything may assign it -------- */

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('customer', 'staff', 'supervisor', 'admin', 'owner'));

/* Both of these columns are written by a trigger from auth_role(), so a
   supervisor sending a message would have violated the old CHECK and been
   refused mid-conversation. */
alter table public.chat_messages drop constraint if exists chat_messages_sender_role_check;
alter table public.chat_messages add constraint chat_messages_sender_role_check
  check (sender_role in ('customer', 'staff', 'supervisor', 'admin', 'owner'));

alter table public.support_ticket_replies
  drop constraint if exists support_ticket_replies_author_role_check;
alter table public.support_ticket_replies add constraint support_ticket_replies_author_role_check
  check (author_role in ('customer', 'staff', 'supervisor', 'admin', 'owner'));

/* ---- 3. Helpers -------------------------------------------------------- */

/* "Any tier that may open the admin app." */
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid()
       and role in ('staff', 'supervisor', 'admin', 'owner')
  );
$$;

/* "Supervisor or above." The tier that may manage the floor but not the
   money. */
create or replace function public.is_supervisor()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid()
       and role in ('supervisor', 'admin', 'owner')
  );
$$;

revoke all on function public.is_supervisor() from public;
grant execute on function public.is_supervisor() to anon, authenticated, service_role;

/* ---- 4. Corrections forced by the widened is_admin() ------------------- */

drop policy if exists app_settings_admin_update on public.app_settings;
create policy app_settings_admin_update on public.app_settings
  for update to authenticated
  using      ((select public.is_manager()))
  with check ((select public.is_manager()));
/* The per-key split (which settings an admin may write versus which are
   owner-only) is enforced by a trigger in migration 0039, because it needs to
   compare the OLD and NEW value and audit the difference. A policy can gate
   the verb; only a trigger can gate the field. */

create or replace function public.protect_profile_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  /* Silently discard a role edit from anyone below manager. Silent on
     purpose: the column has no UPDATE grant for any browser role, so reaching
     this line at all means something server-side is doing it, and the safe
     answer is "keep the old value" rather than abort someone's profile
     save. */
  if new.role is distinct from old.role
     and auth.uid() is not null
     and not public.is_manager() then
    new.role := old.role;
  end if;
  return new;
end;
$$;

/* ---- 5. What supervisor gains over staff ------------------------------- */

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

/*
   These two triggers stamp the role onto a message from the caller's JWT, and
   each carried its OWN copy of the role vocabulary. The CHECK constraints
   above were widened, but a supervisor still could not speak: auth_role()
   returned 'supervisor', which was not in either whitelist, so both refused
   with "Sign in to send a message" — from an account that was very much
   signed in.

   Rewritten to ask role_rank() instead of listing the roles, so the next tier
   added to the hierarchy cannot reintroduce this.
*/
create or replace function public.chat_message_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_role text;
begin
  v_role := public.auth_role();
  if public.role_rank(v_role) < public.role_rank('customer') then
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

create or replace function public.support_reply_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  v_role := public.auth_role();
  if public.role_rank(v_role) < public.role_rank('customer') then
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

drop policy if exists contact_messages_admin_select on public.contact_messages;
create policy contact_messages_admin_select on public.contact_messages
  for select to authenticated
  using ((select public.is_supervisor()));

drop policy if exists contact_messages_admin_update on public.contact_messages;
create policy contact_messages_admin_update on public.contact_messages
  for update to authenticated
  using      ((select public.is_supervisor()))
  with check ((select public.is_supervisor()));

/* ---- 6. Which role transitions each tier may make ---------------------- */

/*
   Rules, stated once and enforced in exactly one place:

     owner   may set any role on anyone, subject to last-owner protection.
     admin   may move an account between customer / staff / supervisor, and
             only if the account is currently one of those three. So an admin
             can create and unmake supervisors, cannot touch a fellow admin or
             the owner, cannot mint an admin or an owner, and cannot change
             their own role.
     others  may not change any role.

   IMMUTABLE and pure, so it can be reasoned about (and tested) on its own.
*/
create or replace function public.can_assign_role(
  p_actor_role text, p_from_role text, p_to_role text, p_is_self boolean
) returns boolean language sql immutable as $$
  select case
    when p_actor_role = 'owner' then
      p_to_role in ('customer', 'staff', 'supervisor', 'admin', 'owner')
    when p_actor_role = 'admin' then
      not coalesce(p_is_self, false)
      and p_from_role in ('customer', 'staff', 'supervisor')
      and p_to_role   in ('customer', 'staff', 'supervisor')
    else false
  end;
$$;

/** The roles a tier may hand out at all — the UI reads this rather than
    deciding for itself, so the dropdown cannot drift from the rule above. */
create or replace function public.assignable_roles(p_actor_role text)
returns text[] language sql immutable as $$
  select case p_actor_role
           when 'owner' then array['customer', 'staff', 'supervisor', 'admin', 'owner']
           when 'admin' then array['customer', 'staff', 'supervisor']
           else array[]::text[]
         end;
$$;

create or replace function public.admin_set_role(p_user_id uuid, p_role text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_old_role    text;
  v_actor_role  text := public.auth_role();
  v_is_self     boolean := (p_user_id = auth.uid());
  v_owner_count integer;
begin
  /* Only manager tiers get past the door; can_assign_role() decides the rest. */
  if not public.is_manager() then
    raise exception 'Only an admin or the owner may change roles'
      using errcode = '42501';
  end if;
  if p_role not in ('customer', 'staff', 'supervisor', 'admin', 'owner') then
    raise exception 'Unknown role: %', p_role using errcode = '22023';
  end if;

  select role into v_old_role from public.profiles where id = p_user_id for update;
  if v_old_role is null then
    raise exception 'No profile for user %', p_user_id using errcode = 'P0002';
  end if;
  if v_old_role = p_role then
    return jsonb_build_object('status', 'unchanged', 'role', p_role);
  end if;

  if not public.can_assign_role(v_actor_role, v_old_role, p_role, v_is_self) then
    /* Worded without articles on purpose: "a admin"/"a owner" read as bugs to
       the person being refused. */
    raise exception
      'Your role (%) cannot change an account from % to %',
      v_actor_role, v_old_role, p_role
      using errcode = '42501',
            hint = 'Admins may move accounts between customer, staff and '
                   'supervisor only. Everything else is the owner''s to do.';
  end if;

  /* Last-owner protection, unchanged: the project must never be left without
     an owner, which also makes it impossible for the final owner to demote
     themselves. */
  if v_old_role = 'owner' and p_role <> 'owner' then
    select count(*) into v_owner_count from public.profiles where role = 'owner';
    if v_owner_count <= 1 then
      raise exception 'Cannot remove the last owner. Promote another owner first.'
        using errcode = '42501';
    end if;
  end if;

  update public.profiles set role = p_role, updated_at = now() where id = p_user_id;

  perform public.log_admin_action(
    'role.change', 'profiles', p_user_id::text,
    'Role changed from ' || v_old_role || ' to ' || p_role,
    jsonb_build_object('from', v_old_role, 'to', p_role, 'actor_role', v_actor_role));

  return jsonb_build_object('status', 'updated', 'from', v_old_role, 'to', p_role);
end;
$$;

/* ---- 7. Team screens must know supervisors exist ----------------------- */

create or replace function public.admin_list_team(
  p_search text default '', p_role text default 'team',
  p_limit integer default 25, p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_rows   jsonb;
  v_total  integer;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_role   text := coalesce(nullif(btrim(p_role), ''), 'team');
  v_actor  text := public.auth_role();
begin
  if not public.is_manager() then
    raise exception 'Team management is available to admins and the owner only'
      using errcode = '42501';
  end if;

  select count(*) into v_total
    from public.profiles p
    join auth.users u on u.id = p.id
   where (v_role = 'all'
          or (v_role = 'team' and p.role in ('owner', 'admin', 'supervisor', 'staff'))
          or p.role = v_role)
     and (v_search is null
          or p.display_name ilike '%' || v_search || '%'
          or u.email ilike '%' || v_search || '%');

  select coalesce(jsonb_agg(r order by r->>'rank', r->>'created_at'), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
               'id', p.id,
               'name', nullif(btrim(p.display_name), ''),
               'email', u.email,
               'phone', nullif(btrim(p.phone), ''),
               'role', p.role,
               'rank', lpad((100 - public.role_rank(p.role))::text, 3, '0'),
               'created_at', u.created_at,
               'last_sign_in_at', u.last_sign_in_at,
               'email_confirmed', (u.email_confirmed_at is not null),
               /* auth.users.banned_until exists natively, so it is reported —
                  but nothing in this project can SET it. Read-only signal. */
               'banned', (u.banned_until is not null and u.banned_until > now()),
               'is_self', (p.id = auth.uid()),
               /* Whether THIS viewer may act on THIS row, decided by the same
                  function admin_set_role() calls. */
               'can_manage', public.can_assign_role(
                                v_actor, p.role, 'staff', p.id = auth.uid())
                             or public.can_assign_role(
                                v_actor, p.role, 'supervisor', p.id = auth.uid())
             ) r
        from public.profiles p
        join auth.users u on u.id = p.id
       where (v_role = 'all'
              or (v_role = 'team' and p.role in ('owner', 'admin', 'supervisor', 'staff'))
              or p.role = v_role)
         and (v_search is null
              or p.display_name ilike '%' || v_search || '%'
              or u.email ilike '%' || v_search || '%')
       order by lpad((100 - public.role_rank(p.role))::text, 3, '0'), u.created_at
       limit greatest(1, least(coalesce(p_limit, 25), 100))
      offset greatest(0, coalesce(p_offset, 0))
    ) s;

  return jsonb_build_object(
    'total', v_total,
    'rows', v_rows,
    'viewer_role', v_actor,
    'can_change_roles', (public.assignable_roles(v_actor) <> array[]::text[]),
    'assignable_roles', public.assignable_roles(v_actor),
    'owner_count', (select count(*) from public.profiles where role = 'owner'));
end;
$$;

create or replace function public.admin_team_member(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_member  jsonb;
  v_role    text;
  v_history jsonb := '[]'::jsonb;
  v_actor   text := public.auth_role();
  v_self    boolean;
  v_options text[];
begin
  if not public.is_manager() then
    raise exception 'Team management is available to admins and the owner only'
      using errcode = '42501';
  end if;

  select p.role, (p.id = auth.uid()) into v_role, v_self
    from public.profiles p where p.id = p_id;
  if v_role is null then
    raise exception 'No such team member' using errcode = 'P0002';
  end if;

  /* The roles THIS viewer may move THIS member to. Computed server-side and
     handed to the UI whole, so the select can only ever offer legal moves. */
  select coalesce(array_agg(r order by public.role_rank(r) desc), array[]::text[])
    into v_options
    from unnest(public.assignable_roles(v_actor)) r
   where public.can_assign_role(v_actor, v_role, r, v_self);

  select jsonb_build_object(
           'id', p.id,
           'name', nullif(btrim(p.display_name), ''),
           'email', u.email,
           'phone', nullif(btrim(p.phone), ''),
           'role', p.role,
           'created_at', u.created_at,
           'last_sign_in_at', u.last_sign_in_at,
           'email_confirmed', (u.email_confirmed_at is not null),
           'banned', (u.banned_until is not null and u.banned_until > now()),
           'is_self', v_self
         ) into v_member
    from public.profiles p
    join auth.users u on u.id = p.id
   where p.id = p_id;

  if public.is_owner() then
    select coalesce(jsonb_agg(jsonb_build_object(
             'at', l.created_at,
             'summary', l.summary,
             'actor_role', l.actor_role,
             'actor_email', (select email from auth.users au where au.id = l.actor_id),
             'detail', l.detail) order by l.created_at desc), '[]'::jsonb)
      into v_history
      from public.admin_audit_log l
     where l.action = 'role.change' and l.target_id = p_id::text;
  end if;

  return jsonb_build_object(
    'member', v_member,
    'history', v_history,
    'history_available', public.is_owner(),
    'can_change_roles', (v_options <> array[]::text[]),
    'role_options', v_options,
    'owner_count', (select count(*) from public.profiles where role = 'owner'));
end;
$$;

commit;
