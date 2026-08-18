-- ---------------------------------------------------------------------------
-- Database-level protection: the project must never reach zero owners.
--
-- admin_set_role() already refuses to demote the last owner, but that only
-- covers the RPC. Deleting the owner's account through the Supabase Auth Admin
-- API takes a different route entirely:
--
--     DELETE auth.users  ->  profiles_id_fkey ON DELETE CASCADE  ->  profiles
--
-- which never touches the RPC. A BEFORE DELETE trigger on public.profiles sits
-- directly in that cascade and aborts the whole transaction, so the auth row
-- survives too.
--
-- DELIBERATELY NO SERVER BYPASS. The tier triggers (0022) exempt callers with
-- no auth.uid(), because those enforce a PERMISSION and a server caller is
-- already trusted. This one enforces a DATA INVARIANT — "an owner always
-- exists" — which must hold for service_role, the Auth Admin API and psql
-- alike, since those are exactly the paths that could empty the table.
--
-- To legitimately remove the final owner: promote a replacement first, or, for
-- a deliberate teardown, disable this trigger as a superuser.
-- ---------------------------------------------------------------------------

create or replace function public.prevent_last_owner_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owners integer;
begin
  /* Deleting anyone who is not an owner is none of this trigger's business. */
  if old.role is distinct from 'owner' then
    return old;
  end if;

  /* Count owners OTHER than the row being removed. */
  select count(*) into v_owners
    from public.profiles
   where role = 'owner' and id <> old.id;

  if v_owners = 0 then
    raise exception
      'Cannot delete the last owner (%). Promote another owner first.', old.id
      using errcode = '42501',
            hint = 'Use admin_set_role() to make another account an owner, then retry.';
  end if;

  return old;
end;
$$;

drop trigger if exists profiles_prevent_last_owner_delete on public.profiles;
create trigger profiles_prevent_last_owner_delete
  before delete on public.profiles
  for each row execute function public.prevent_last_owner_delete();

comment on function public.prevent_last_owner_delete is
  'Data invariant: at least one owner must always exist. Fires inside the auth.users -> profiles delete cascade, so it also blocks the Auth Admin API.';
