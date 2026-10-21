/* ==========================================================================
   0087 — End-of-day: keep earlier versions, accept late-shift reports
   --------------------------------------------------------------------------
   WHAT HAPPENED (2026-10-19)

   A supervisor submitted at 00:28 on 19 Oct — a late report about the 18th.
   The server files every save under "today" (Lagos), so it went onto the
   19th's row. At 23:04 he submitted the 19th's report into that same row,
   and staff_day_report_save() replaced all five text fields. Nothing kept
   the 00:28 text, so it cannot be recovered. On 20/21 Oct the same thing
   split one report across two days: submitted 23:58, then again 00:00:21.

   WHAT THIS ADDS (approved 2026-10-21)

   1. staff_day_report_versions — whenever the text of a SUBMITTED report is
      changed, the previous text is copied here first (trigger). Drafts are
      not versioned; review columns are not text and never create a version.
      Read through admin_day_report_versions(): supervisors and above, or the
      report's own author. No client grant on the table.

   2. Late-shift reports. Before 04:00 Lagos time, a handler may still write,
      submit or discard YESTERDAY's report — filed under yesterday, where it
      belongs. After 04:00 only today, as before. The client says which day
      the form is for and sends it; the server decides whether that day is
      open (kt_report_day_open), so a form left open across midnight can no
      longer drop a report onto the wrong day.

   3. staff_day_report() also returns 'editable' and 'versions' (count), so
      the form knows whether it may be edited and the author sees that
      earlier text was kept.

   NOTHING EXISTING CHANGES

   No staff_day_reports row is updated or deleted. Existing reports have no
   earlier versions (none were ever kept). Review and follow-up are as
   before; admin_day_reports() is untouched.
   ========================================================================== */

begin;

/* ---- 1. Earlier versions -------------------------------------------------- */

create table if not exists public.staff_day_report_versions (
  id              bigserial primary key,
  report_id       uuid not null references public.staff_day_reports (id) on delete cascade,
  staff_id        uuid not null,
  business_date   date not null,
  problems        text not null default '',
  customer_issues text not null default '',
  stock_issues    text not null default '',
  follow_ups      text not null default '',
  notes           text not null default '',
  submitted_at    timestamptz,
  replaced_at     timestamptz not null default now(),
  replaced_by     uuid
);

create index if not exists staff_day_report_versions_report_idx
  on public.staff_day_report_versions (report_id, replaced_at desc);

alter table public.staff_day_report_versions enable row level security;
revoke all on public.staff_day_report_versions from anon, authenticated;

comment on table public.staff_day_report_versions is
  'Earlier text of a submitted end-of-day report, kept whenever the author '
  'changes it (0087). Read via admin_day_report_versions() only.';

create or replace function public.kt_keep_day_report_version()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'submitted'
     and (new.problems        is distinct from old.problems
       or new.customer_issues is distinct from old.customer_issues
       or new.stock_issues    is distinct from old.stock_issues
       or new.follow_ups      is distinct from old.follow_ups
       or new.notes           is distinct from old.notes) then
    insert into public.staff_day_report_versions
      (report_id, staff_id, business_date, problems, customer_issues,
       stock_issues, follow_ups, notes, submitted_at, replaced_by)
    values
      (old.id, old.staff_id, old.business_date, old.problems, old.customer_issues,
       old.stock_issues, old.follow_ups, old.notes, old.submitted_at, auth.uid());
  end if;
  return new;
end;
$$;
revoke all on function public.kt_keep_day_report_version() from public, anon, authenticated;

drop trigger if exists staff_day_reports_keep_version on public.staff_day_reports;
create trigger staff_day_reports_keep_version
  before update on public.staff_day_reports
  for each row execute function public.kt_keep_day_report_version();

create or replace function public.admin_day_report_versions(p_report_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_rep public.staff_day_reports;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;
  select * into v_rep from public.staff_day_reports where id = p_report_id;
  if v_rep.id is null then
    raise exception 'That report does not exist' using errcode = 'P0002';
  end if;
  /* Supervisors and above see anyone's; a handler only their own. */
  if not public.is_supervisor() and v_rep.staff_id is distinct from auth.uid() then
    raise exception 'You can only see your own report history' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'report_id', v_rep.id,
    'versions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', v.id,
               'problems', v.problems, 'customer_issues', v.customer_issues,
               'stock_issues', v.stock_issues, 'follow_ups', v.follow_ups, 'notes', v.notes,
               'submitted_at', v.submitted_at, 'replaced_at', v.replaced_at)
             order by v.replaced_at desc, v.id desc)
        from public.staff_day_report_versions v
       where v.report_id = v_rep.id), '[]'::jsonb));
end;
$$;
revoke all on function public.admin_day_report_versions(uuid) from public, anon;
grant execute on function public.admin_day_report_versions(uuid) to authenticated;

/* ---- 2. Which day may a handler still write? ----------------------------- */

/* Today (Lagos), or yesterday until 04:00 Lagos time. */
create or replace function public.kt_report_day_open(p_day date)
returns boolean language sql stable security definer set search_path = public as $$
  select p_day = (public.kt_today_start() at time zone 'Africa/Lagos')::date
      or (p_day = (public.kt_today_start() at time zone 'Africa/Lagos')::date - 1
          and (now() at time zone 'Africa/Lagos')::time < time '04:00');
$$;
revoke all on function public.kt_report_day_open(date) from public, anon;
grant execute on function public.kt_report_day_open(date) to authenticated;

/* As 0052, with the date rule replaced by kt_report_day_open(). */
create or replace function public.staff_day_report_save(
  p_problems        text default '',
  p_customer_issues text default '',
  p_stock_issues    text default '',
  p_follow_ups      text default '',
  p_notes           text default '',
  p_submit          boolean default false,
  p_day             date default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_date date;
  v_id   uuid;
  v_was  text;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  v_date := case when p_day is null
                 then (public.kt_today_start() at time zone 'Africa/Lagos')::date
                 else p_day end;

  /* Today, or yesterday until 04:00 for a late shift (0087). Anything older
     is a memory, not a record, and back-filling it would put a timestamp on
     it that implies otherwise. */
  if not public.kt_report_day_open(v_date) then
    raise exception 'The report for % has closed. Late reports are accepted until 04:00 the next morning.',
      to_char(v_date, 'Dy DD Mon') using errcode = '22023';
  end if;

  select id, status into v_id, v_was
    from public.staff_day_reports
   where staff_id = v_uid and business_date = v_date;

  if v_id is null then
    insert into public.staff_day_reports
      (staff_id, business_date, status, problems, customer_issues,
       stock_issues, follow_ups, notes, submitted_at)
    values
      (v_uid, v_date, case when p_submit then 'submitted' else 'draft' end,
       btrim(coalesce(p_problems, '')), btrim(coalesce(p_customer_issues, '')),
       btrim(coalesce(p_stock_issues, '')), btrim(coalesce(p_follow_ups, '')),
       btrim(coalesce(p_notes, '')),
       case when p_submit then now() end)
    returning id into v_id;
  else
    update public.staff_day_reports
       set problems        = btrim(coalesce(p_problems, '')),
           customer_issues = btrim(coalesce(p_customer_issues, '')),
           stock_issues    = btrim(coalesce(p_stock_issues, '')),
           follow_ups      = btrim(coalesce(p_follow_ups, '')),
           notes           = btrim(coalesce(p_notes, '')),
           status          = case when p_submit then 'submitted' else status end,
           submitted_at    = case when p_submit then now() else submitted_at end
     where id = v_id;
  end if;

  if p_submit and coalesce(v_was, 'draft') <> 'submitted' then
    perform public.log_admin_action(
      'eod.submitted', 'staff_day_reports', v_id::text,
      'End-of-day report submitted for ' || v_date::text,
      jsonb_build_object('business_date', v_date));
  elsif p_submit then
    /* A re-submission replaces text a manager may already have read; the
       earlier text is in staff_day_report_versions, and the log says so. */
    perform public.log_admin_action(
      'eod.resubmitted', 'staff_day_reports', v_id::text,
      'End-of-day report updated after submitting, for ' || v_date::text,
      jsonb_build_object('business_date', v_date));
  end if;

  return jsonb_build_object('status', 'ok', 'id', v_id,
                            'submitted', p_submit, 'business_date', v_date);
end;
$$;
revoke all on function public.staff_day_report_save(text, text, text, text, text, boolean, date) from public, anon;
grant execute on function public.staff_day_report_save(text, text, text, text, text, boolean, date) to authenticated;

/* As 0053, with the same open-day rule. */
create or replace function public.staff_day_report_discard(p_day date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_date date;
  v_n    integer;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  v_date := case when p_day is null
                 then (public.kt_today_start() at time zone 'Africa/Lagos')::date
                 else p_day end;

  if not public.kt_report_day_open(v_date) then
    raise exception 'You can only discard a draft for a day that is still open' using errcode = '22023';
  end if;

  delete from public.staff_day_reports
   where staff_id = v_uid
     and business_date = v_date
     and status = 'draft';
  get diagnostics v_n = row_count;

  return jsonb_build_object('status', 'ok', 'discarded', v_n);
end;
$$;
revoke all on function public.staff_day_report_discard(date) from public, anon;
grant execute on function public.staff_day_report_discard(date) to authenticated;

/* As 0052, plus 'editable', 'late_open_until' and 'versions'. */
create or replace function public.staff_day_report(p_day date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_from timestamptz;
  v_to   timestamptz;
  v_rep  public.staff_day_reports;
  v_date date;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  v_from := case when p_day is null then public.kt_today_start()
                 else (p_day::timestamp at time zone 'Africa/Lagos') end;
  v_to := v_from + interval '1 day';
  v_date := (v_from at time zone 'Africa/Lagos')::date;

  select * into v_rep
    from public.staff_day_reports
   where staff_id = v_uid
     and business_date = v_date;

  return jsonb_build_object(
    'business_date', v_date,
    'staff_id',      v_uid,
    'role',          public.auth_role(),
    'editable',      public.kt_report_day_open(v_date),
    /* Yesterday's report stays open until this moment (null outside the
       late window), so the form can say so. */
    'late_open_until', case when public.kt_report_day_open((public.kt_today_start() at time zone 'Africa/Lagos')::date - 1)
                            then (((public.kt_today_start() at time zone 'Africa/Lagos')::date)::timestamp + time '04:00')
                                 at time zone 'Africa/Lagos' end,
    'activity',      public.kt_staff_day_activity(v_uid, v_from, v_to),
    'report', case when v_rep.id is null then null else jsonb_build_object(
      'id',              v_rep.id,
      'status',          v_rep.status,
      'problems',        v_rep.problems,
      'customer_issues', v_rep.customer_issues,
      'stock_issues',    v_rep.stock_issues,
      'follow_ups',      v_rep.follow_ups,
      'notes',           v_rep.notes,
      'submitted_at',    v_rep.submitted_at,
      'updated_at',      v_rep.updated_at,
      'reviewed_at',     v_rep.reviewed_at,
      'review_note',     v_rep.review_note,
      'needs_follow_up', v_rep.needs_follow_up,
      'versions',        (select count(*) from public.staff_day_report_versions v where v.report_id = v_rep.id)) end);
end;
$$;
revoke all on function public.staff_day_report(date) from public, anon;
grant execute on function public.staff_day_report(date) to authenticated;

commit;
