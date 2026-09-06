/* ==========================================================================
   Phase 11D.4 — the shell can finally tell that it is suspended
   --------------------------------------------------------------------------
   Suspension closes the workspace server-side, but the admin shell could not
   SEE it. shell.js gates on rank(profile.role) < rank('staff'), and a
   suspended member is still 'staff' — so the gate passed, the whole
   workspace rendered, and every RPC behind it then returned 403. A broken
   screen instead of an explanation.

   The obvious fix — granting suspended_at to authenticated — is the wrong
   one twice over. 0069 removed those columns from the client grant
   deliberately, and profiles_select_own is is_admin() (staff+), so granting
   the column would also let every active staff member read who else is
   suspended. This asks a narrower question instead.

   WHAT THIS CANNOT DO

   It takes no argument. There is no user id to pass, so there is no shape of
   this call that asks about anybody else — the answer is always about
   auth.uid() and nothing else. It returns two fields and neither is
   sensitive: the role the caller already knows, and whether their own
   workspace is closed, which they are told by notification anyway.

   suspend_reason, suspended_by and every other column stay where 0069 put
   them: reachable only through the manager-gated Team RPCs.
   ========================================================================== */

begin;

create or replace function public.my_account_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           /* Same value auth_role() reports, repeated here so the shell needs
              one round trip rather than two. */
           'role', coalesce((select p.role from public.profiles p
                              where p.id = auth.uid()), 'anon'),
           /* A boolean, not the timestamp: when it happened is management's
              record, not something the shell needs to render. */
           'suspended', coalesce((select p.suspended_at is not null
                                    from public.profiles p
                                   where p.id = auth.uid()), false)
         );
$$;

comment on function public.my_account_status is
  'The caller''s own role and whether their staff workspace is suspended. '
  'Takes no argument by design: there is no way to ask about another account. '
  'Never returns suspend_reason or suspended_by.';

revoke all on function public.my_account_status() from public, anon;
grant execute on function public.my_account_status() to authenticated;

commit;
