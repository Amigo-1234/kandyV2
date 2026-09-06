/* ==========================================================================
   Phase 11D.3 — nobody suspends themselves, and one fixture is restored
   --------------------------------------------------------------------------
   0067 delegated the self-check to can_assign_role(). That function only
   applies its `not p_is_self` test in the `admin` branch; the `owner` branch
   tests the target tier alone. An owner could therefore suspend themselves,
   and the last-active-owner counter is no defence while a second owner
   exists.

   Two changes, both narrow:

     1. admin_set_suspended() refuses v_is_self before anything else, for
        every tier.
     2. The p15-owner test fixture, suspended while proving this, is restored
        by exact id with assertions.

   can_assign_role() itself is NOT touched. Its behaviour is correct for role
   changes — an owner may legitimately change their own role, held safe by
   the last-owner rule — and altering it would reach 30-plus call sites for a
   problem that belongs to this one function.
   ========================================================================== */

begin;

create or replace function public.admin_set_suspended(
  p_user_id uuid, p_suspended boolean, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor_role  text := public.auth_role();
  v_role        text;
  v_name        text;
  v_was         timestamptz;
  v_is_self     boolean := (p_user_id = auth.uid());
  v_active_owners integer;
begin
  /* is_manager() is already suspension-aware, so a suspended admin cannot
     reach this at all — including to un-suspend themselves. */
  if not public.is_manager() then
    raise exception 'Only an admin or the owner may change account status'
      using errcode = '42501';
  end if;

  select role, nullif(btrim(coalesce(display_name, '')), ''), suspended_at
    into v_role, v_name, v_was
    from public.profiles where id = p_user_id;
  if v_role is null then
    raise exception 'No profile for user %', p_user_id using errcode = 'P0002';
  end if;

  /* Suspension is a staff-workspace action. A customer has no workspace to
     close, so this is refused rather than silently doing nothing. */
  if public.role_rank(v_role) < public.role_rank('staff') then
    raise exception 'That account is not a team member' using errcode = '42501';
  end if;

  /*
     SELF FIRST, AND NOT THROUGH can_assign_role().

     The previous version delegated this, on the assumption that
     can_assign_role() refuses anyone acting on themselves. It does not: only
     its `admin` branch tests p_is_self. The `owner` branch checks the target
     tier and nothing else, so an owner passed straight through the guard and
     suspended themselves — which is exactly what happened to the p15-owner
     fixture, and would have happened to a real owner the first time one
     tried it.

     Suspension is not a role change, so it does not inherit that function's
     view of self-service. Nobody, at any tier, closes their own workspace.
  */
  if v_is_self then
    raise exception 'You cannot change your own account status'
      using errcode = '42501',
            hint = 'Ask another admin or the owner to do it.';
  end if;

  /* The SAME rule role changes use. p_to_role is passed as the account's own
     role because suspension does not move anyone between tiers — this asks
     only "may you act on an account at this tier?". It carries the existing
     refusals for free: admin cannot touch an admin or the owner, and nobody
     may act on themselves. */
  if not public.can_assign_role(v_actor_role, v_role, v_role, v_is_self) then
    raise exception
      'Your role (%) cannot change the status of a % account', v_actor_role, v_role
      using errcode = '42501',
            hint = 'Admins may suspend staff and supervisors only. '
                   'Nobody may suspend themselves.';
  end if;

  if p_suspended then
    /* Never leave the project without a usable owner. Counted over ACTIVE
       owners, so a second owner still allows suspending the first. */
    if v_role = 'owner' then
      select count(*) into v_active_owners
        from public.profiles where role = 'owner' and suspended_at is null;
      if v_active_owners <= 1 then
        raise exception 'Cannot suspend the last active owner.'
          using errcode = '42501',
                hint = 'Promote or reactivate another owner first.';
      end if;
    end if;

    update public.profiles
       set suspended_at   = now(),
           suspended_by   = auth.uid(),
           suspend_reason = nullif(btrim(coalesce(p_reason, '')), '')
     where id = p_user_id;
  else
    /* suspended_by and the reason are cleared on reactivation: the account is
       clean again, and the history of who did what lives in the audit log,
       which is the record that is not allowed to be edited. */
    update public.profiles
       set suspended_at = null, suspended_by = null, suspend_reason = null
     where id = p_user_id;
  end if;

  perform public.log_admin_action(
    case when p_suspended then 'staff.suspend' else 'staff.reactivate' end,
    'profiles', p_user_id::text,
    (case when p_suspended then 'Suspended ' else 'Reactivated ' end)
      || coalesce(v_name, 'a team member') || ' (' || v_role || ')',
    /* The reason is recorded in the audit detail, where only managers can
       read it. It is deliberately absent from the summary line. */
    jsonb_build_object('role', v_role, 'suspended', p_suspended,
                       'reason', nullif(btrim(coalesce(p_reason, '')), '')));

  /* Generic both ways. No reason, no author, no flag, nothing to click —
     and it still reaches them because their own-data notification policy is
     keyed on auth.uid(), not on is_admin(). */
  perform public.notify_user(
    p_user_id, 'staff_notice',
    case when p_suspended then 'Your staff account has been suspended'
         else 'Your staff account has been reactivated' end,
    case when p_suspended
         then 'Your staff account has been suspended. Please contact management.'
         else 'Your staff account has been reactivated.' end,
    null, false);

  return jsonb_build_object('status', 'ok', 'id', p_user_id,
                            'suspended', p_suspended, 'role', v_role);
end;
$$;

revoke all on function public.admin_set_suspended(uuid, boolean, text) from public, anon;
grant execute on function public.admin_set_suspended(uuid, boolean, text) to authenticated;

/* ---- Restore the fixture ------------------------------------------------
   By exact id, and only if every fact still matches what was verified: the
   id, the role, and that it is currently suspended. Any mismatch aborts the
   transaction rather than widening the update.
*/
do $$
declare
  v_id   uuid := '777b3907-93e1-45b3-8b76-ca6381b1e452';
  v_role text;
  v_susp timestamptz;
  v_n    integer;
begin
  select role, suspended_at into v_role, v_susp
    from public.profiles where id = v_id;

  if v_role is null then
    raise exception 'Fixture profile % not found', v_id;
  end if;
  if v_role <> 'owner' then
    raise exception 'Refusing: % is role %, expected owner', v_id, v_role;
  end if;
  if v_susp is null then
    raise notice 'Already active; nothing to restore.';
    return;
  end if;

  update public.profiles
     set suspended_at = null, suspended_by = null, suspend_reason = null
   where id = v_id;

  /* Exactly one row, and no other account left suspended by this fix. */
  select count(*) into v_n from public.profiles where suspended_at is not null;
  if v_n <> 0 then
    raise exception 'Expected 0 suspended accounts after restore, found %', v_n;
  end if;

  raise notice 'Restored p15-owner fixture %.', v_id;
end $$;

commit;
