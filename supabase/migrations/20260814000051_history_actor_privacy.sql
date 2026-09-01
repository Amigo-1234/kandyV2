/* ==========================================================================
   order_status_history.created_by is internal, and customers could read it
   --------------------------------------------------------------------------
   Found while testing Phase 02. order_status_history_select_own lets a
   customer read the history of their OWN orders, which is correct and is what
   drives the tracking page. But the table grant is `grant select on
   order_status_history`, covering every column — so created_by, the staff
   member's user id, came back with it. Twenty rows visible to a test
   customer, thirteen carrying a handler id.

   It is not dramatic: the value is an opaque uuid, and profiles_select_own
   already refuses to resolve it into a name, so a customer sees an
   unexplained identifier rather than "Idris handled your order". But it is
   internal attribution with no customer-facing purpose, it is exactly what
   Phase 02 set out to keep on the inside, and the fix is small.

   RLS cannot help here: a policy chooses ROWS, never columns. The column
   grant is the only instrument that works, and it applies to `authenticated`
   as a whole — so narrowing it takes created_by away from handlers too. The
   admin therefore stops reading the table directly and asks a function
   instead, which is a better shape anyway: one call returns the history with
   the actor already resolved, where the admin previously made two.

   The customer path is untouched. js/services/orders.js embeds
   order_status_history ( status, note, created_at ), all of which stay
   granted.
   ========================================================================== */

begin;

/* ---- 1. Narrow the column grant ---------------------------------------- */

/*
   Re-granting the columns that are actually read, and omitting created_by.
   The trigger that writes these rows is SECURITY DEFINER and so is unaffected
   by column grants — it keeps recording the actor exactly as before. Nothing
   stops being RECORDED here; something stops being READABLE.
*/
revoke select on public.order_status_history from authenticated;
grant select (id, order_id, status, note, created_at)
  on public.order_status_history to authenticated;

comment on column public.order_status_history.created_by is
  'The handler who made this change. Internal: deliberately NOT in the '
  'authenticated column grant, so a customer reading their own order history '
  'cannot see it. Handlers read it through admin_order_history().';

/* ---- 2. The admin reads it through a function -------------------------- */

/*
   Returns one order's history with the actor already resolved to a name, for
   any handler tier. is_admin() is the same boundary the direct table read had
   through order_status_history_admin_write, so this narrows nothing for
   staff — it simply moves where created_by is reachable from.

   A null created_by means the system wrote the row: checkout writes the
   opening 'New', and the payment flows write theirs. Those are reported as
   system actions rather than attributed to whoever happened to be nearby.
*/
create or replace function public.admin_order_history(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_rows jsonb;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',         h.id,
           'status',     h.status,
           'note',       h.note,
           'created_at', h.created_at,
           'actor_id',   h.created_by,
           'actor_name', nullif(btrim(coalesce(p.display_name, '')), ''),
           'actor_role', p.role)
         order by h.created_at), '[]'::jsonb)
    into v_rows
    from public.order_status_history h
    left join public.profiles p on p.id = h.created_by
   where h.order_id = p_order_id;

  return v_rows;
end;
$$;

revoke all on function public.admin_order_history(uuid) from public, anon;
grant execute on function public.admin_order_history(uuid) to authenticated;

comment on function public.admin_order_history(uuid) is
  'One order''s status history with the acting handler resolved to a name. '
  'Staff+. The only route to order_status_history.created_by.';

commit;
