/* ==========================================================================
   Phase 13 (3/3) — close the internal functions to the browser
   --------------------------------------------------------------------------
   Found by testing §19, and it is a real hole rather than a tidy-up.

   THE MISTAKE
   -----------
   Every migration in this project that created an internal SECURITY DEFINER
   helper ended with

       revoke all on function public.notify_user(...) from public;

   and that line does almost nothing here. `public` is the PUBLIC pseudo-role.
   Supabase's default privileges hand an EXPLICIT grant to `anon` and
   `authenticated` on new functions in the public schema, and revoking from
   PUBLIC leaves those two untouched. The ACLs told the story plainly:

       log_admin_action   postgres=X/postgres | service_role=X/postgres
       notify_user        postgres=X | anon=X | authenticated=X | service_role=X

   log_admin_action was safe by accident of how it was written; notify_user
   was not.

   WHAT THAT ALLOWED
   -----------------
   notify_user() takes a recipient, a title and a body and writes straight
   into public.notifications as its definer. Any signed-in customer could
   call it over PostgREST and post a notification to ANY other user, with any
   wording — the precise forgery §19 asks about. The table's own INSERT grant
   was correctly withheld, so the direct route was closed and the earlier
   phase's tests (which only tried the direct route) passed. The RPC route was
   never tried until now.

   notify_roles() had the same shape and would have let a customer alert every
   handler at once. wants_push() leaked whether another account had a channel
   switched off.

   THE FIX
   -------
   Revoke from public AND anon AND authenticated, on every function that is
   not meant to be reached from a browser. Trigger functions are included:
   they are not usefully callable through PostgREST, but leaving them granted
   would keep the misleading ACL that hid this in the first place.

   Nothing an interface uses is revoked here — the app's own RPCs are listed
   in the DO block's exclusion set and were re-tested afterwards.
   ========================================================================== */

begin;

do $$
declare
  r record;
  /* Everything the browser is SUPPOSED to be able to call. Anything not in
     this list gets closed. Kept explicit rather than pattern-matched on the
     name, because "starts with admin_" is not a security boundary. */
  v_public_api text[] := array[
    /* role helpers, read by policies and by the admin shell */
    'auth_role', 'is_admin', 'is_manager', 'is_owner', 'is_supervisor',
    'role_rank', 'can_assign_role', 'assignable_roles',
    /* customer-facing */
    'create_checkout_order', 'pay_order_from_wallet',
    'register_push_subscription', 'unregister_push_subscription',
    'my_push_subscriptions', 'accept_staff_invitation',
    /* admin app */
    'admin_dashboard', 'admin_chat_inbox', 'admin_support_unread',
    'admin_list_customers', 'admin_get_customer', 'admin_can_delete_customer',
    'admin_list_team', 'admin_team_member', 'admin_set_role',
    'admin_invite_teammate', 'admin_list_invitations', 'admin_revoke_invitation',
    'admin_settings', 'setting_tier', 'setting_label', 'kt_today_start',
    'admin_finance_overview', 'admin_reconciliation', 'admin_payment_events',
    'admin_refund_order', 'admin_adjust_wallet',
    'admin_log_customer_export', 'admin_log_finance', 'admin_notify_customer'
  ];
begin
  for r in
    select p.oid::regprocedure::text as sig, p.proname
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prokind = 'f'
       and not (p.proname = any (v_public_api))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;

/*
   And make sure the ones that ARE the public API say so explicitly, rather
   than relying on a default privilege that could change under us.
*/
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure::text as sig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prokind = 'f'
       and p.proname = any (array[
         'auth_role', 'is_admin', 'is_manager', 'is_owner', 'is_supervisor',
         'role_rank', 'can_assign_role', 'assignable_roles',
         'create_checkout_order', 'pay_order_from_wallet',
         'register_push_subscription', 'unregister_push_subscription',
         'my_push_subscriptions', 'accept_staff_invitation',
         'admin_dashboard', 'admin_chat_inbox', 'admin_support_unread',
         'admin_list_customers', 'admin_get_customer', 'admin_can_delete_customer',
         'admin_list_team', 'admin_team_member', 'admin_set_role',
         'admin_invite_teammate', 'admin_list_invitations', 'admin_revoke_invitation',
         'admin_settings', 'setting_tier', 'setting_label', 'kt_today_start',
         'admin_finance_overview', 'admin_reconciliation', 'admin_payment_events',
         'admin_refund_order', 'admin_adjust_wallet',
         'admin_log_customer_export', 'admin_log_finance', 'admin_notify_customer'])
  loop
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $$;

/*
   anon keeps only what a signed-out visitor genuinely evaluates. Everything
   else that survived the loop above was granted to `authenticated` there;
   this takes the leftover default grant off anon. These functions all refuse
   a non-staff caller anyway, so this is defence in depth — but "anon may call
   admin_dashboard" is not a sentence that should be true.
*/
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure::text as sig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prokind = 'f'
       and (p.proname like 'admin\_%' or p.proname in (
             'create_checkout_order', 'pay_order_from_wallet',
             'register_push_subscription', 'unregister_push_subscription',
             'my_push_subscriptions', 'accept_staff_invitation',
             'admin_settings', 'setting_tier', 'setting_label', 'kt_today_start',
             'can_assign_role', 'assignable_roles'))
  loop
    execute format('revoke all on function %s from anon', r.sig);
  end loop;
end $$;

/* The catalogue helpers a signed-OUT visitor needs. anon evaluates these
   inside the read policies on menu_items, categories and quick_picks —
   0018 already had to restore this once, for the same reason. */
grant execute on function public.is_admin()       to anon;
grant execute on function public.is_manager()     to anon;
grant execute on function public.is_owner()       to anon;
grant execute on function public.is_supervisor()  to anon;
grant execute on function public.auth_role()      to anon;
grant execute on function public.role_rank(text)  to anon;

commit;
