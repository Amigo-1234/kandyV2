-- ---------------------------------------------------------------------------
-- Team management — read side.
--
-- Role CHANGES are not implemented here. admin_set_role already exists, is
-- owner-only, carries last-owner protection and writes the audit row. Adding a
-- second path would mean two places to keep those guarantees correct, so this
-- migration deliberately adds no mutation whatsoever.
--
-- These are RPCs rather than table reads because a team list needs email,
-- created_at and last_sign_in_at, which live in auth.users — a schema
-- PostgREST does not expose. The alternative is granting the browser access to
-- auth.users, which is not a trade worth making for a convenience.
--
-- What is deliberately NOT returned: password hashes, tokens, recovery
-- material, provider identities, raw app metadata. Only the fields a manager
-- needs in order to know who is on the team.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- admin_list_team — manager+ (admin may VIEW even though only owner may change)
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_team(
  p_search  text    default '',
  p_role    text    default 'team',   -- 'team' | 'all' | a specific role
  p_limit   integer default 25,
  p_offset  integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows   jsonb;
  v_total  integer;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_role   text := coalesce(nullif(btrim(p_role), ''), 'team');
begin
  if not public.is_manager() then
    raise exception 'Team management is available to admins and the owner only'
      using errcode = '42501';
  end if;

  select count(*) into v_total
    from public.profiles p
    join auth.users u on u.id = p.id
   where (v_role = 'all'
          or (v_role = 'team' and p.role in ('owner', 'admin', 'staff'))
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
                  but nothing in this project can SET it, and this migration
                  does not add a way. Read-only signal only. */
               'banned', (u.banned_until is not null and u.banned_until > now()),
               'is_self', (p.id = auth.uid())
             ) r
        from public.profiles p
        join auth.users u on u.id = p.id
       where (v_role = 'all'
              or (v_role = 'team' and p.role in ('owner', 'admin', 'staff'))
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
    'viewer_role', public.auth_role(),
    'can_change_roles', public.is_owner(),   -- mirrors admin_set_role exactly
    'owner_count', (select count(*) from public.profiles where role = 'owner')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_team_member — one member, plus role history for the owner.
--
-- History comes from admin_audit_log. It is owner-gated because the log
-- records who did what across the whole project, and an admin has no business
-- reading another administrator's action history.
-- ---------------------------------------------------------------------------
create or replace function public.admin_team_member(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_member  jsonb;
  v_history jsonb := '[]'::jsonb;
begin
  if not public.is_manager() then
    raise exception 'Team management is available to admins and the owner only'
      using errcode = '42501';
  end if;

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
           'is_self', (p.id = auth.uid())
         ) into v_member
    from public.profiles p
    join auth.users u on u.id = p.id
   where p.id = p_id;

  if v_member is null then
    raise exception 'No such team member' using errcode = 'P0002';
  end if;

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
    'can_change_roles', public.is_owner(),
    'owner_count', (select count(*) from public.profiles where role = 'owner')
  );
end;
$$;

revoke all on function public.admin_list_team(text,text,integer,integer) from public, anon;
revoke all on function public.admin_team_member(uuid)                    from public, anon;
grant execute on function public.admin_list_team(text,text,integer,integer) to authenticated, service_role;
grant execute on function public.admin_team_member(uuid)                    to authenticated, service_role;

comment on function public.admin_list_team is
  'Read-only team roster for manager+. Adds no role-mutation path; admin_set_role remains the only one.';
