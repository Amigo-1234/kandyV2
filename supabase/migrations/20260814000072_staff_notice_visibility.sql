/* ==========================================================================
   Phase 12 (Part 0) — the staff notice becomes visible
   --------------------------------------------------------------------------
   0066 added the 'staff_notice' type and inserted it correctly. Seven rows
   exist in production, every one addressed to the flag's subject, every one
   with related_id null and email_sent_at null, every one with push_sent_at
   stamped. Nothing about that path is broken.

   What was missed is the registration step. admin_notifications() reads the
   notifications table through a type ALLOWLIST, and a type absent from that
   list is invisible in the admin app — which is where staff land, because
   homeFor('staff') returns admin/#/orders. So the one recipient class this
   feature exists for was the one class that could not see it.

   This is the fourth time the same omission has happened: admin_ticket in
   Phase 14, admin_announcement in Phase 05, admin_flag in Phase 10, and now
   staff_notice. 0065's own header called it in advance — "a type absent from
   this list notifies nobody visibly".

   ONE TYPE ADDED, IN BOTH PLACES
   ------------------------------
   The rows query and the unread count carry the same list and must not
   disagree: a row the panel shows but the badge does not count reads as a
   bug from the other direction. Both gain 'staff_notice' and nothing else
   changes — same signature, same is_admin() gate, same user_id = auth.uid()
   scoping, same limit clamp.

   WHAT THIS DOES NOT DO
   ---------------------
   It does not touch staff_flags, its single is_manager() SELECT policy, or
   any grant. The subject still cannot read the flag, its details, severity,
   category, author or id. related_id stays null on the notice, so there is
   no identifier to walk back to a flag row, and neither renderer produces a
   link for this type. The subject learns that something exists and is sent
   to a person to discuss it — which is the whole of the Phase 11D design.
   ========================================================================== */

begin;

create or replace function public.admin_notifications(
  p_limit integer default 20, p_unread_only boolean default false
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_rows jsonb;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', n.id, 'type', n.type, 'title', n.title, 'message', n.message,
           'related_id', n.related_id, 'read', n.read, 'created_at', n.created_at)
         order by n.created_at desc), '[]'::jsonb)
    into v_rows
    from (select * from public.notifications
           where user_id = v_uid
             and type in ('admin_order', 'admin_support', 'admin_ticket',
                          'admin_announcement', 'admin_flag', 'staff_notice',
                          'payment', 'message')
             and (not p_unread_only or read = false)
           order by created_at desc
           limit greatest(1, least(coalesce(p_limit, 20), 50))) n;

  return jsonb_build_object(
    'rows', v_rows,
    'unread', (select count(*) from public.notifications
                where user_id = v_uid and read = false
                  and type in ('admin_order', 'admin_support', 'admin_ticket',
                               'admin_announcement', 'admin_flag', 'staff_notice',
                               'payment', 'message')),
    'unread_orders', (select count(*) from public.notifications
                       where user_id = v_uid and read = false and type = 'admin_order'),
    'viewer_role', public.auth_role());
end;
$$;

revoke all on function public.admin_notifications(integer, boolean) from public, anon;
grant execute on function public.admin_notifications(integer, boolean) to authenticated;

commit;
