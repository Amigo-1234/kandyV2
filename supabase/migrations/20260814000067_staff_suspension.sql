/* ==========================================================================
   PROPOSED — Phase 11D.2 staff suspension       *** NOT APPLIED ***
   --------------------------------------------------------------------------
   Suspension closes the staff workspace. It is not a demotion and not a
   deletion: the role is untouched, every historical record is untouched, and
   the person keeps their own customer-side account — their orders, their
   addresses, their wallet, their notifications. That last one matters,
   because it is how they receive the notice telling them what happened.

   WHERE THE CHECK GOES, AND WHY NOT EVERYWHERE

   Four helpers gate the staff surface and all four read profiles:
   is_admin (staff+), is_supervisor, is_manager (admin+), is_owner. Adding
   the condition to those four is what makes suspension real — is_admin()
   alone is consulted 144 times across the migrations, so one condition
   closes every admin RLS policy and every admin RPC at once.

   Two functions deliberately do NOT get it:

     auth_role()       returns the role string and feeds log_admin_action's
                       actor_role. Blanking it would make the audit trail lie
                       about who did what, which is the opposite of the point.

     can_assign_role() reads nothing — it is a pure function of its four
                       arguments. There is no session in it to suspend.

   WHY THIS CANNOT LOCK THE OWNER OUT

     - can_assign_role() already refuses admin -> admin and admin -> owner,
       and already refuses acting on yourself. Reused verbatim, so suspension
       inherits the hierarchy rather than inventing one.
     - The last ACTIVE owner cannot be suspended. Counted over
       (role = 'owner' and suspended_at is null), so suspending the
       second-to-last owner is fine and suspending the final one is refused.
     - A suspended account cannot reactivate anything, itself included:
       admin_set_suspended requires is_manager(), which is now false while
       suspended.
   ========================================================================== */

begin;

/* ---- 1. The marks ------------------------------------------------------ */

alter table public.profiles
  add column if not exists suspended_at   timestamptz,
  add column if not exists suspended_by   uuid references public.profiles (id) on delete set null,
  add column if not exists suspend_reason text;

create index if not exists profiles_suspended_idx on public.profiles (suspended_at)
  where suspended_at is not null;

comment on column public.profiles.suspended_at is
  'Non-null closes the staff workspace for this account. The role is NOT '
  'changed and no history is touched; the person keeps their own customer '
  'account. Cleared by admin_set_suspended(..., false).';

/* The reason is management-only. It is never returned to the subject: the
   notice they receive says to contact management and nothing else. */
comment on column public.profiles.suspend_reason is
  'Management-only. Never shown to the suspended person.';

/* ---- 2. The four gates ------------------------------------------------- */

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid()
       and role in ('staff', 'supervisor', 'admin', 'owner')
       and suspended_at is null
  );
$$;

create or replace function public.is_supervisor()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid()
       and role in ('supervisor', 'admin', 'owner')
       and suspended_at is null
  );
$$;

create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and role in ('admin', 'owner')
       and suspended_at is null
  );
$$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and role = 'owner'
       and suspended_at is null
  );
$$;

/* ---- 3. Suspend / reactivate ------------------------------------------- */

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

commit;
