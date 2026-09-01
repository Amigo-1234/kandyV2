/* ==========================================================================
   Careers — the admin half
   --------------------------------------------------------------------------
   job_applications has existed since 0029 and the storefront has been writing
   to it: anon holds INSERT, the policy pins status = 'new', and SELECT is
   is_manager(). What was never built is the other end. Applications have been
   landing in a table nobody could open, and — because there is no UPDATE grant
   at all — `status` was immutable for every role including the owner, so the
   three states the CHECK constraint allows were unreachable.

   Two things are added, and nothing else:

     1. A way for admin+ to move an application through new -> reviewing ->
        closed. Column-scoped: `status` is the only writable column, so a
        handler cannot rewrite an applicant's name, phone or message.

     2. An audit row per move, through the existing log_admin_action(), the
        same way audit_order_status_change() records an order moving.

   NOT added: a second inbox, a notification type, or any widening of who may
   read an application. is_manager() is admin+ and stays that way — staff and
   supervisors have no business in a hiring pipeline, and the Careers nav item
   is gated to match rather than to enforce.
   ========================================================================== */

begin;

/* ---- Who may move an application -------------------------------------- */

/*
   Column-level, not table-level. `grant update on job_applications` would
   make every column writable and RLS would not narrow that — a policy decides
   WHICH ROWS, never WHICH COLUMNS. The applicant's own words are a record of
   what they sent us and are not editable from the admin at any tier.
*/
grant update (status) on public.job_applications to authenticated;

drop policy if exists job_applications_admin_update on public.job_applications;
create policy job_applications_admin_update on public.job_applications
  for update to authenticated
  using ((select public.is_manager()))
  with check ((select public.is_manager()));

/* ---- Every move is recorded ------------------------------------------- */

/*
   Mirrors audit_order_status_change(). The applicant's name is included in
   the summary because "application 4f2a… moved to closed" is unreadable in a
   log a human is meant to scan; the phone, email and message are not, because
   an audit row is read far more often than the record it points at.
*/
create or replace function public.audit_job_application_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status and auth.uid() is not null then
    perform public.log_admin_action(
      'career.status_change', 'job_applications', new.id::text,
      'Application from ' || coalesce(nullif(btrim(new.name), ''), 'an applicant') ||
        ' (' || new.role_slug || '): ' || old.status || ' -> ' || new.status,
      jsonb_build_object('from', old.status, 'to', new.status, 'role_slug', new.role_slug));
  end if;
  return new;
end;
$$;

revoke all on function public.audit_job_application_status() from public, anon, authenticated;

drop trigger if exists job_applications_status_audit on public.job_applications;
create trigger job_applications_status_audit
  after update of status on public.job_applications
  for each row execute function public.audit_job_application_status();

/* ---- Counts for the board and the dashboard tile ----------------------- */

/*
   One round trip for the three counts the inbox header needs. The list itself
   stays ordinary PostgREST — job_applications_admin_select already scopes it
   — so this exists for the tallies alone, exactly as admin_notifications()
   does for the bell.
*/
create or replace function public.admin_career_counts()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_manager() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  return (
    select jsonb_build_object(
             'new',       count(*) filter (where status = 'new'),
             'reviewing', count(*) filter (where status = 'reviewing'),
             'closed',    count(*) filter (where status = 'closed'),
             'total',     count(*))
      from public.job_applications);
end;
$$;

revoke all on function public.admin_career_counts() from public, anon;
grant execute on function public.admin_career_counts() to authenticated;

commit;
