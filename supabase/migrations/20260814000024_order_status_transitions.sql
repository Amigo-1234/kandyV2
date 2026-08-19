-- ---------------------------------------------------------------------------
-- Order status: legal transitions, enforced server-side.
--
-- enforce_order_status_tier() already decided WHO may cancel. It did not
-- constrain WHICH move is legal, so any admin-tier caller could PATCH an order
-- straight from New to Completed through PostgREST and skip the kitchen
-- entirely. Hiding buttons would not have stopped that.
--
-- Extends the existing trigger rather than adding a second one, so there is
-- still exactly one place where order status rules live.
--
--   New        -> Preparing | Cancelled
--   Preparing  -> Out       | Cancelled
--   Out        -> Completed | Cancelled
--   Completed  -> (terminal)
--   Cancelled  -> (terminal)
--
-- Server-side callers (auth.uid() IS NULL) still bypass: settlement, backfills
-- and migrations are trusted by their database role, as established in 0022.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_order_status_tier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed text[];
begin
  if auth.uid() is null then return new; end if;
  if new.status is not distinct from old.status then return new; end if;

  /* Who may cancel. */
  if new.status = 'Cancelled' and not public.is_manager() then
    raise exception 'Only an admin or owner may cancel an order'
      using errcode = '42501';
  end if;

  /* Which move is legal at all. */
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
