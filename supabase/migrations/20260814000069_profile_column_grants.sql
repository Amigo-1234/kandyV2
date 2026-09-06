/* ==========================================================================
   Phase 11D.4 — close the suspend_reason leak, and let Team see the truth
   --------------------------------------------------------------------------
   Two defects from 0067, both found by the audit meant to build the UI on it.

   1. suspend_reason was readable by the person it was written about.

      0067 documented the column as management-only in a COMMENT. A comment is
      not a control. public.profiles carries a table-wide SELECT grant to
      authenticated (0003:116) and profiles_select_own lets anyone read their
      own row, so a suspended staff member could select the manager's private
      reason for suspending them.

      The grant is now column-level and lists exactly what the application
      reads. There is precedent: 0009 did this to UPDATE for the same reason.
      The only browser read of profiles is account.js:56, selecting seven
      columns; suspend_reason, suspended_at, suspended_by and updated_at are
      not among them and are not granted.

      Every other reader of profiles is a SECURITY DEFINER function running as
      the owner, so none is affected. Verified: no RLS policy reads profiles
      directly — the role gates go through is_admin() and friends, which are
      SECURITY DEFINER precisely so a policy never needs the grant.

   2. The Team RPCs could not see suspension at all.

      They returned `banned`, the native auth.users signal nothing here writes.
      They now also return suspended_at, who did it by name, and the reason —
      the reason gated on the same authority that decides whether the viewer
      may act on that row.

   Both RPCs are reproduced from 0037 with those fields inserted and nothing
   else changed. can_assign_role() untouched, hierarchy untouched, no
   financial object involved.
   ========================================================================== */

begin;

/* ---- 1. The grant -------------------------------------------------------
   PostgreSQL cannot revoke one column while a table-wide grant exists, so the
   table-wide SELECT is dropped and replaced by the explicit list. INSERT is
   left alone (profiles_insert_own is the auth trigger's safety net) and
   UPDATE is already column-limited by 0009.
*/
revoke select on public.profiles from authenticated;
grant select (id, display_name, phone, photo_url, role, created_at, legacy_firebase_uid)
  on public.profiles to authenticated;

comment on column public.profiles.suspend_reason is
  'Management-only, enforced by column grant: authenticated has no SELECT on '
  'this column. Reachable only through admin_list_team / admin_team_member, '
  'and only for a viewer who may act on that member.';

/* ---- 2. Team RPCs learn about suspension -------------------------------- */

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
               /* The project's own suspension, which admin_set_suspended() writes
                  and the four role gates read. `banned` above is the native auth
                  signal and remains unwritten. */
               'suspended_at', p.suspended_at,
               'suspended_by_name', (select nullif(btrim(coalesce(sb.display_name, '')), '')
                                       from public.profiles sb where sb.id = p.suspended_by),
               /* Management-only, gated on the SAME expression as can_manage below:
                  a manager who may not act on this row cannot read why it was
                  suspended either. Null rather than omitted, so the shape stays
                  stable for the UI. */
               'suspend_reason', case
                   when public.can_assign_role(v_actor, p.role, 'staff', p.id = auth.uid())
                     or public.can_assign_role(v_actor, p.role, 'supervisor', p.id = auth.uid())
                   then p.suspend_reason else null end,
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
           'suspended_at', p.suspended_at,
           'suspended_by_name', (select nullif(btrim(coalesce(sb.display_name, '')), '')
                                   from public.profiles sb where sb.id = p.suspended_by),
           /* v_options is non-empty exactly when this viewer may act on this
              member — the same authority that may read the reason. */
           'suspend_reason', case
               when v_options <> array[]::text[] then p.suspend_reason
               else null end,
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
