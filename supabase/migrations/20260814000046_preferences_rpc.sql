/* ==========================================================================
   Phase 13 (4/4) — writing notification preferences
   --------------------------------------------------------------------------
   0043 gave `authenticated` column-level INSERT and UPDATE on
   notification_preferences and left the client to upsert. Testing showed two
   things wrong with that:

     1. An upsert needs UPDATE on the CONFLICT column too, so PostgREST asked
        for `GRANT UPDATE ON user_id` — and user_id is the one column that
        must never be writable, because writing it is how a row changes owner.

     2. updated_at was in the UPDATE grant but not the INSERT grant, so a
        client that sent it succeeded on the second save and 403'd on the
        first. A timestamp the client sets is spoofable anyway.

   Both disappear if the client stops touching the table. This adds one RPC
   that writes only the caller's own row, only the five switches, and stamps
   updated_at itself — and takes the write grants away entirely.

   SELECT stays granted: reading your own preferences is what the policy is
   for, and the policy already restricts it to your own row.
   ========================================================================== */

begin;

revoke insert, update on public.notification_preferences from authenticated;

create or replace function public.set_notification_preferences(
  p_push_orders     boolean default null,
  p_push_support    boolean default null,
  p_push_marketing  boolean default null,
  p_email_orders    boolean default null,
  p_sound_new_order boolean default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_row public.notification_preferences%rowtype;
begin
  if v_uid is null then
    raise exception 'Sign in to change your notification settings' using errcode = '28000';
  end if;

  /* NULL means "leave this one alone", so a screen can save one switch
     without having to send the other four back. */
  insert into public.notification_preferences as np
    (user_id, push_orders, push_support, push_marketing, email_orders, sound_new_order)
  values
    (v_uid,
     coalesce(p_push_orders, true), coalesce(p_push_support, true),
     coalesce(p_push_marketing, true), coalesce(p_email_orders, true),
     coalesce(p_sound_new_order, true))
  on conflict (user_id) do update
    set push_orders     = coalesce(p_push_orders,     np.push_orders),
        push_support    = coalesce(p_push_support,    np.push_support),
        push_marketing  = coalesce(p_push_marketing,  np.push_marketing),
        email_orders    = coalesce(p_email_orders,    np.email_orders),
        sound_new_order = coalesce(p_sound_new_order, np.sound_new_order),
        updated_at      = now()
  returning * into v_row;

  return jsonb_build_object(
    'push_orders', v_row.push_orders,
    'push_support', v_row.push_support,
    'push_marketing', v_row.push_marketing,
    'email_orders', v_row.email_orders,
    'sound_new_order', v_row.sound_new_order);
end;
$$;

revoke all on function public.set_notification_preferences(boolean, boolean, boolean, boolean, boolean)
  from public, anon;
grant execute on function public.set_notification_preferences(boolean, boolean, boolean, boolean, boolean)
  to authenticated;

commit;
