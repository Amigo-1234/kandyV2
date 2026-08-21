/* ==========================================================================
   Phase 11 (2/4) — invitations, so an admin can create a supervisor
   --------------------------------------------------------------------------
   The problem: assigning a role needs a profile, a profile needs an auth
   user, and creating an auth user needs the service_role key — which must
   never reach a browser.

   WHAT THIS DOES INSTEAD
   ----------------------
   Nobody creates the account. The invitee creates it themselves, through the
   sign-up flow that already exists, and the invitation only decides what role
   that account ends up with:

     1. Admin fills in name / email / role.        admin_invite_teammate()
        The database mints a 244-bit token, stores only its SHA-256, and
        returns the raw token EXACTLY ONCE so the admin can pass on the link.

     2. The invitee opens the link and signs in or signs up with that email —
        ordinary Supabase Auth, their own password, no second auth system.

     3. The link's page calls accept_staff_invitation(token), which promotes
        them server-side.                          accept_staff_invitation()

   WHY THE TOKEN IS SAFE TO HAND AROUND
   ------------------------------------
   It is not a bearer credential on its own. Redeeming it requires a session
   whose email matches the invited address AND is confirmed, so holding the
   link without controlling the inbox achieves nothing. That is two factors —
   the link and the mailbox — where a password-reset-link-as-invitation (which
   Phase 11 §4 rightly forbids) would have been one, and would have handed the
   holder an existing account rather than a new one.

   The raw token is never stored, never logged, and never written to the audit
   detail. If it is lost the invitation is revoked and reissued, not
   recovered.

   NOT A SECOND ROLE-CHANGING SYSTEM
   ---------------------------------
   admin_set_role() stays the authoritative path for changing an EXISTING
   account's role. This file covers only the case admin_set_role cannot: an
   account that does not exist yet. The two share can_assign_role(), so an
   admin cannot invite someone to a role they could not have promoted them to.
   ========================================================================== */

begin;

/* ---- Table ------------------------------------------------------------- */

create table if not exists public.staff_invitations (
  id            uuid primary key default gen_random_uuid(),
  email         text        not null,
  role          text        not null check (role in ('staff', 'supervisor', 'admin')),
  display_name  text        not null default '',
  phone         text        not null default '',
  /* SHA-256 of the raw token, hex. The raw token exists only in the response
     that created it. */
  token_hash    text        not null unique,
  status        text        not null default 'pending'
                            check (status in ('pending', 'accepted', 'revoked')),
  expires_at    timestamptz not null,
  created_by    uuid        references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  accepted_by   uuid        references auth.users(id) on delete set null,
  accepted_at   timestamptz,
  revoked_by    uuid        references auth.users(id) on delete set null,
  revoked_at    timestamptz,
  constraint staff_invitations_email_lower check (email = lower(email))
);

create index if not exists staff_invitations_email_idx
  on public.staff_invitations (email) where status = 'pending';
create index if not exists staff_invitations_created_idx
  on public.staff_invitations (created_at desc);

alter table public.staff_invitations enable row level security;

/* No grants and no policies, on purpose. Every route in and out of this table
   is a SECURITY DEFINER function below, so there is no shape of PostgREST
   request — not even from the owner — that can read a token hash, list
   invitations directly, or insert one. The privilege to try does not exist. */
revoke all on public.staff_invitations from anon, authenticated;

/* ---- The role trigger must let an accepted invitation through ---------- */

/*
   protect_profile_role() reverts any role edit made by a caller below
   manager. The invitee IS below manager at the moment they are promoted — a
   customer, by definition — so without this the accepted invitation would
   have been silently undone and the invitee left as a customer with a
   "welcome to the team" message.

   The bypass is a transaction-local GUC, the same device migration 0031 used
   for the chat unread guard: set with is_local = true, so it is discarded at
   commit and cannot leak between statements, sessions or connections. It is
   set for exactly one UPDATE inside accept_staff_invitation() and cleared
   immediately afterwards.
*/
create or replace function public.protect_profile_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('kt.role_internal', true), '') = '1' then
    return new;
  end if;
  if new.role is distinct from old.role
     and auth.uid() is not null
     and not public.is_manager() then
    new.role := old.role;
  end if;
  return new;
end;
$$;

/* ---- Issue ------------------------------------------------------------- */

create or replace function public.admin_invite_teammate(
  p_email text, p_role text, p_name text default '', p_phone text default ''
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor   text := public.auth_role();
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_role    text := btrim(coalesce(p_role, ''));
  v_token   text;
  v_id      uuid;
  v_expires timestamptz := now() + interval '7 days';
begin
  if not public.is_manager() then
    raise exception 'Only an admin or the owner may invite a teammate'
      using errcode = '42501';
  end if;

  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;

  /* An invitation may only offer a role the inviter could have assigned by
     hand. can_assign_role() is the same function admin_set_role() uses, so
     there is one rule, not two that can drift. 'customer' is excluded because
     an invitation is a team seat; a customer just signs up. */
  if v_role not in ('staff', 'supervisor', 'admin')
     or not public.can_assign_role(v_actor, 'customer', v_role, false) then
    raise exception 'Your role (%) cannot invite someone as %', v_actor, v_role
      using errcode = '42501',
            hint = 'Admins may invite staff and supervisors. '
                   'Admins and owners are the owner''s to appoint.';
  end if;

  if exists (select 1 from auth.users where lower(email) = v_email) then
    raise exception 'That email already has an account. Change its role from the team list instead.'
      using errcode = '23505';
  end if;

  if exists (select 1 from public.staff_invitations
              where email = v_email and status = 'pending' and expires_at > now()) then
    raise exception 'There is already a pending invitation for %', v_email
      using errcode = '23505',
            hint = 'Revoke the existing invitation first if you need to reissue it.';
  end if;

  /* Two v4 UUIDs from the server CSPRNG: 244 bits of entropy in 64 hex
     characters, using only core functions — no extension to be missing on
     some future database. */
  v_token := replace(gen_random_uuid()::text, '-', '')
          || replace(gen_random_uuid()::text, '-', '');

  insert into public.staff_invitations
    (email, role, display_name, phone, token_hash, expires_at, created_by)
  values
    (v_email, v_role, btrim(coalesce(p_name, '')),
     btrim(coalesce(p_phone, '')),
     encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
     v_expires, auth.uid())
  returning id into v_id;

  /* The audit records WHO was invited to WHAT. It must never record the
     token, or the log would become a way to escalate. */
  perform public.log_admin_action(
    'team.invite_created', 'staff_invitations', v_id::text,
    'Invited ' || v_email || ' as ' || v_role,
    jsonb_build_object('email', v_email, 'role', v_role, 'expires_at', v_expires));

  return jsonb_build_object(
    'id', v_id, 'email', v_email, 'role', v_role,
    'expires_at', v_expires,
    /* Once. Not stored, not recoverable. */
    'token', v_token);
end;
$$;

/* ---- List and revoke --------------------------------------------------- */

create or replace function public.admin_list_invitations(p_status text default 'pending')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_status text := coalesce(nullif(btrim(p_status), ''), 'pending');
  v_rows   jsonb;
begin
  if not public.is_manager() then
    raise exception 'Team management is available to admins and the owner only'
      using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(r order by r->>'created_at' desc), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
               'id', i.id,
               'email', i.email,
               'role', i.role,
               'name', nullif(i.display_name, ''),
               'phone', nullif(i.phone, ''),
               'status', case when i.status = 'pending' and i.expires_at <= now()
                              then 'expired' else i.status end,
               'expires_at', i.expires_at,
               'created_at', i.created_at,
               'invited_by', (select email from auth.users u where u.id = i.created_by),
               'accepted_at', i.accepted_at
             ) r
        from public.staff_invitations i
       where v_status = 'all'
          or (v_status = 'pending' and i.status = 'pending' and i.expires_at > now())
          or (v_status = 'expired' and i.status = 'pending' and i.expires_at <= now())
          or i.status = v_status
       order by i.created_at desc
       limit 100
    ) s;

  /* token_hash is not in that projection and never will be. */
  return jsonb_build_object('rows', v_rows, 'viewer_role', public.auth_role());
end;
$$;

create or replace function public.admin_revoke_invitation(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_inv public.staff_invitations%rowtype;
begin
  if not public.is_manager() then
    raise exception 'Only an admin or the owner may revoke an invitation'
      using errcode = '42501';
  end if;

  select * into v_inv from public.staff_invitations where id = p_id for update;
  if not found then
    raise exception 'No such invitation' using errcode = 'P0002';
  end if;
  if v_inv.status <> 'pending' then
    raise exception 'That invitation is already %', v_inv.status using errcode = '22023';
  end if;

  update public.staff_invitations
     set status = 'revoked', revoked_at = now(), revoked_by = auth.uid()
   where id = p_id;

  perform public.log_admin_action(
    'team.invite_revoked', 'staff_invitations', p_id::text,
    'Revoked the invitation for ' || v_inv.email,
    jsonb_build_object('email', v_inv.email, 'role', v_inv.role));

  return jsonb_build_object('status', 'revoked', 'email', v_inv.email);
end;
$$;

/* ---- Redeem ------------------------------------------------------------ */

/*
   Called by the INVITEE, signed in as themselves. Everything that decides the
   outcome is read from the database and from the JWT: the caller supplies a
   token and nothing else, so there is no field they can tilt in their favour.
*/
create or replace function public.accept_staff_invitation(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid       uuid := auth.uid();
  v_email     text;
  v_confirmed timestamptz;
  v_hash      text;
  v_inv       public.staff_invitations%rowtype;
  v_current   text;
begin
  if v_uid is null then
    raise exception 'Sign in with the invited email address to accept this invitation'
      using errcode = '28000';
  end if;

  select lower(u.email), u.email_confirmed_at into v_email, v_confirmed
    from auth.users u where u.id = v_uid;

  /* The mailbox is the second factor. Without this check the link alone would
     be enough, and a leaked link would be a promotion. */
  if v_confirmed is null then
    raise exception 'Confirm your email address first, then open the invitation link again'
      using errcode = '42501';
  end if;

  v_hash := encode(sha256(convert_to(btrim(coalesce(p_token, '')), 'UTF8')), 'hex');

  select * into v_inv from public.staff_invitations where token_hash = v_hash for update;
  if not found then
    raise exception 'This invitation link is not valid' using errcode = 'P0002';
  end if;
  if v_inv.status = 'accepted' then
    raise exception 'This invitation has already been used' using errcode = '22023';
  end if;
  if v_inv.status = 'revoked' then
    raise exception 'This invitation was revoked' using errcode = '42501';
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'This invitation expired on %',
      to_char(v_inv.expires_at, 'DD Mon YYYY') using errcode = '42501',
      hint = 'Ask whoever invited you to send a new one.';
  end if;
  if v_inv.email <> v_email then
    raise exception 'This invitation was sent to a different email address'
      using errcode = '42501',
            hint = 'Sign in as ' || v_inv.email || ' and open the link again.';
  end if;

  select role into v_current from public.profiles where id = v_uid for update;

  /* An invitation may only ever raise someone. Accepting a supervisor
     invitation as an existing admin must not quietly demote them. */
  if public.role_rank(v_current) >= public.role_rank(v_inv.role) then
    update public.staff_invitations
       set status = 'accepted', accepted_at = now(), accepted_by = v_uid
     where id = v_inv.id;
    return jsonb_build_object('status', 'unchanged', 'role', v_current);
  end if;

  /* Transaction-local, cleared at commit. See protect_profile_role() above. */
  perform set_config('kt.role_internal', '1', true);
  update public.profiles
     set role = v_inv.role, updated_at = now(),
         display_name = case when btrim(coalesce(display_name, '')) = ''
                             then v_inv.display_name else display_name end,
         phone        = case when btrim(coalesce(phone, '')) = ''
                             then v_inv.phone else phone end
   where id = v_uid;
  perform set_config('kt.role_internal', '', true);

  update public.staff_invitations
     set status = 'accepted', accepted_at = now(), accepted_by = v_uid
   where id = v_inv.id;

  /* Logged after the promotion, so actor_role reads as the role they now
     hold — which is the fact an auditor is looking for. */
  perform public.log_admin_action(
    'team.invite_accepted', 'profiles', v_uid::text,
    v_email || ' accepted the ' || v_inv.role || ' invitation',
    jsonb_build_object('from', v_current, 'to', v_inv.role,
                       'invitation_id', v_inv.id,
                       'invited_by', v_inv.created_by));

  return jsonb_build_object('status', 'accepted', 'from', v_current, 'to', v_inv.role);
end;
$$;

/* ---- Execution rights -------------------------------------------------- */

revoke all on function public.admin_invite_teammate(text, text, text, text) from public;
revoke all on function public.admin_list_invitations(text) from public;
revoke all on function public.admin_revoke_invitation(uuid) from public;
revoke all on function public.accept_staff_invitation(text) from public;
revoke all on function public.can_assign_role(text, text, text, boolean) from public;
revoke all on function public.assignable_roles(text) from public;

grant execute on function public.admin_invite_teammate(text, text, text, text) to authenticated;
grant execute on function public.admin_list_invitations(text) to authenticated;
grant execute on function public.admin_revoke_invitation(uuid) to authenticated;
grant execute on function public.accept_staff_invitation(text) to authenticated;
grant execute on function public.can_assign_role(text, text, text, boolean) to authenticated;
grant execute on function public.assignable_roles(text) to authenticated;

commit;
