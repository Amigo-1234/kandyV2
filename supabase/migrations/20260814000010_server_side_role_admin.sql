-- ---------------------------------------------------------------------------
-- Allow trusted server-side role administration; keep clients locked out.
--
-- protect_profile_role() previously reverted ANY role change unless is_admin()
-- was true. On a server connection (psql / service_role) auth.uid() is NULL, so
-- is_admin() is false and the trigger silently reverted the change — an UPDATE
-- reported "1 row" while writing nothing.
--
-- The fix distinguishes a client session from a trusted server one:
--   * auth.uid() IS NOT NULL  -> a real browser session; unchanged behaviour,
--     a non-admin's attempt to change role is silently reverted.
--   * auth.uid() IS NULL      -> psql or service_role; the change is allowed.
--
-- This does NOT widen client capability. Since 0009, `authenticated` holds no
-- UPDATE grant on profiles.role at all, so a browser is rejected by column
-- privilege before RLS or this trigger is ever consulted. The trigger is
-- defence in depth, not the only lock.
-- ---------------------------------------------------------------------------

create or replace function public.protect_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and auth.uid() is not null
     and not public.is_admin() then
    new.role := old.role;
  end if;
  return new;
end;
$$;
