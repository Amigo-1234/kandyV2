/* ==========================================================================
   Order accountability — read what is already recorded
   --------------------------------------------------------------------------
   WHY THERE IS NO assigned_to COLUMN IN THIS MIGRATION

   Phase 02 asked whether explicit order assignment is justified before
   building it. The operational data says no:

     * The real team is TWO people — the owner and one staff member.
     * Of nine real customer orders, EIGHT were carried start to finish by a
       single person. The ninth involved two.
     * The owner personally handled seven of the nine.

   You do not allocate work between two people standing in the same kitchen.
   An assign / reassign / claim / unassign system here would be a column to
   fill and a screen to maintain, not a workflow anyone follows — exactly the
   thing the brief warned against building.

   WHAT IS ACTUALLY MISSING

   Not the data. order_status_history already stamps created_by on every
   handler action, and its RLS already lets staff and above read it. What was
   missing is that nobody ever read it: the admin fetched only
   (id, status, note, created_at), so the screen showed the ROLE that acted
   ("Updated by owner.") and never the person.

   So this migration adds no accountability data. It adds ONE read that turns
   the accountability already being collected into something a manager can
   see, shaped for the future end-of-day report to consume.

   RESPONSIBILITY IS DERIVED, NOT DECLARED
   The person responsible for an order is the one who picked it up — the
   actor of the first move away from New. That is a fact the database already
   holds, it cannot go stale, it never disagrees with the status history, and
   it needs no column, no UI and no reassignment rules.
   ========================================================================== */

begin;

/*
   Day-scoped operational activity.

   READS order_status_history, NOT admin_audit_log. That distinction is the
   whole security argument: the audit log is owner-only because it records
   what colleagues did across every module, and widening it is not a
   reporting decision. order_status_history is operational, and its existing
   policy (order_status_history_admin_write, `using (is_admin())`) already
   lets any staff member read it.

   TIERING
   Totals are staff+. The PER-PERSON breakdown is supervisor+ and absent
   rather than empty below that. A staff member could in principle join these
   tables themselves, so this is not a secrecy claim — it is a product one:
   handing every handler a colleague-by-colleague activity list is a
   management decision the owner has not made, and the conservative default
   is the one that can be widened later without having to take something
   away.
*/
create or replace function public.admin_order_activity(p_day date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_sup   boolean := public.is_supervisor();
  v_from  timestamptz;
  v_to    timestamptz;
  v_ord   jsonb;
  v_staff jsonb := null;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  /* The same Africa/Lagos boundary the dashboard and the scoop report use, so
     no two numbers on a manager's screen can describe different days. */
  v_from := case
              when p_day is null then public.kt_today_start()
              else (p_day::timestamp at time zone 'Africa/Lagos')
            end;
  v_to := v_from + interval '1 day';

  /* ---- Orders, by what happened to them in the window ------------------ */
  select jsonb_build_object(
           /* placed in the window */
           'received',  count(*) filter (where o.created_at >= v_from and o.created_at < v_to),
           /* still open, of those placed in the window */
           'pending',   count(*) filter (where o.created_at >= v_from and o.created_at < v_to
                                           and o.status not in ('Completed', 'Cancelled')),
           /* placed in the window and never touched by a handler: the real
              "needs attention" signal for a small kitchen. */
           'unattended', count(*) filter (where o.created_at >= v_from and o.created_at < v_to
                                            and o.status = 'New'
                                            and not exists (
                                              select 1 from public.order_status_history h
                                               where h.order_id = o.id
                                                 and h.created_by is not null)),
           /* finished IN the window, whenever they were placed — an order
              cooked overnight still completes today. */
           'completed', (select count(distinct h.order_id) from public.order_status_history h
                          where h.status = 'Completed'
                            and h.created_at >= v_from and h.created_at < v_to),
           'cancelled', (select count(distinct h.order_id) from public.order_status_history h
                          where h.status = 'Cancelled'
                            and h.created_at >= v_from and h.created_at < v_to))
    into v_ord
    from public.orders o;

  /* ---- Per handler, derived entirely from recorded actions ------------- */
  if v_sup then
    with acts as (
      /* Handler actions only. The checkout RPC writes the opening 'New' row
         with a null created_by, and so do the payment flows — filtering on
         created_by is what separates a person from the system. */
      select h.order_id, h.status, h.created_at, h.created_by
        from public.order_status_history h
       where h.created_by is not null
         and h.created_at >= v_from
         and h.created_at <  v_to
    ),
    /* Who picked each order up: the actor of its FIRST move away from New,
       across all time rather than only this window, so an order carried over
       from yesterday is still credited to whoever took it. */
    pickup as (
      select distinct on (h.order_id) h.order_id, h.created_by
        from public.order_status_history h
       where h.created_by is not null
         and h.status <> 'New'
       order by h.order_id, h.created_at
    ),
    per as (
      select a.created_by                                            as staff_id,
             count(*)                                                as status_changes,
             count(distinct a.order_id)                              as orders_touched,
             count(*) filter (where a.status = 'Completed')          as orders_completed,
             count(*) filter (where a.status = 'Cancelled')          as orders_cancelled,
             min(a.created_at)                                       as first_action_at,
             max(a.created_at)                                       as last_action_at,
             (select count(*) from pickup p
               where p.created_by = a.created_by
                 and p.order_id in (select order_id from acts))      as orders_picked_up
        from acts a
       group by a.created_by
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'staff_id',         per.staff_id,
             'name',             nullif(btrim(coalesce(pr.display_name, '')), ''),
             'role',             pr.role,
             'orders_touched',   per.orders_touched,
             'orders_picked_up', per.orders_picked_up,
             'orders_completed', per.orders_completed,
             'orders_cancelled', per.orders_cancelled,
             'status_changes',   per.status_changes,
             'first_action_at',  per.first_action_at,
             'last_action_at',   per.last_action_at)
           order by per.orders_touched desc, pr.display_name), '[]'::jsonb)
      into v_staff
      from per
      left join public.profiles pr on pr.id = per.staff_id;
  end if;

  return jsonb_build_object(
    'day',          (v_from at time zone 'Africa/Lagos')::date,
    'from',         v_from,
    'to',           v_to,
    'generated_at', now(),
    'viewer_role',  public.auth_role(),
    'includes_staff_breakdown', v_sup,
    'orders',       v_ord,
    'by_staff',     v_staff);
end;
$$;

revoke all on function public.admin_order_activity(date) from public, anon;
grant execute on function public.admin_order_activity(date) to authenticated;

comment on function public.admin_order_activity(date) is
  'Operational activity for one Africa/Lagos day, derived from '
  'order_status_history. Totals staff+, per-person breakdown supervisor+. '
  'Reads no audit-log rows. Shaped for the future end-of-day report.';

commit;
