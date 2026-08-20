-- ---------------------------------------------------------------------------
-- Finance audit entry point.
--
-- log_admin_action() is service_role only, so a browser cannot write an audit
-- row directly — correct, but it means Finance needs its own narrow door.
--
-- This accepts a fixed set of finance actions and nothing else: an admin
-- cannot use it to forge an arbitrary audit entry (a "role.change" that never
-- happened, say). The actor and role are taken from the JWT, never from the
-- caller's arguments.
-- ---------------------------------------------------------------------------

create or replace function public.admin_log_finance(
  p_action  text,
  p_summary text,
  p_detail  jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_manager() then
    raise exception 'Finance is available to admins and the owner only'
      using errcode = '42501';
  end if;

  if p_action not in ('finance.view_sensitive',
                      'finance.reconciliation_review',
                      'finance.payment_events_review',
                      'finance.wallet_review') then
    raise exception 'Unsupported finance audit action: %', p_action
      using errcode = '22023';
  end if;

  perform public.log_admin_action(
    p_action, 'finance', null,
    coalesce(nullif(btrim(p_summary), ''), p_action),
    coalesce(p_detail, '{}'::jsonb));
end;
$$;

revoke all on function public.admin_log_finance(text,text,jsonb) from public, anon;
grant execute on function public.admin_log_finance(text,text,jsonb) to authenticated, service_role;

comment on function public.admin_log_finance is
  'Narrow audit door for Finance. Action is whitelisted; actor and role come from the JWT.';
