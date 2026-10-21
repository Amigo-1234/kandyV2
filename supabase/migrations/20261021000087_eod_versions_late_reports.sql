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

   1. staff_day_report_versions — whenever the text of a report is changed
      (draft or submitted), the previous text is copied here FIRST, in the
      same transaction (BEFORE trigger); and when a draft is discarded, its
      text is copied here before the row is deleted. So no report text can
      disappear without a recoverable copy. Versions are never deleted with
      their report (report_id is set null instead). Review columns are not
      text and never create a version. Read through
      admin_day_report_versions(staff, day): supervisors and above, or the
      person themself. It looks versions up by person and day, not by report
      row, so a discarded draft stays readable after its row is deleted and
      after a new report is started for the same day. No client grant on the
      table.

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
   before. admin_day_reports() returns the same rows and team figures, plus a
   'versions' count per person and, listed but not counted, anyone whose
   only text for the day is a discarded draft.
   ========================================================================== */

begin;

/* ---- 1. Earlier versions -------------------------------------------------- */

create table if not exists public.staff_day_report_versions (
  id              bigserial primary key,
  /* Set null, never cascaded: a discarded draft's text outlives its row. */
  report_id       uuid references public.staff_day_reports (id) on delete set null,
  staff_id        uuid not null,
  business_date   date not null,
  status          text not null,                 -- status of the text when it was replaced
  reason          text not null default 'edited' check (reason in ('edited', 'discarded')),
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
create index if not exists staff_day_report_versions_staff_day_idx
  on public.staff_day_report_versions (staff_id, business_date);

alter table public.staff_day_report_versions enable row level security;
revoke all on public.staff_day_report_versions from anon, authenticated;

comment on table public.staff_day_report_versions is
  'Earlier text of an end-of-day report (draft or submitted), kept whenever '
  'the author changes or discards it (0087). Read via '
  'admin_day_report_versions(staff, day) only.';

/* Runs BEFORE the row changes, in the same transaction: if the copy cannot
   be written, the edit or discard fails too. */
create or replace function public.kt_keep_day_report_version()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_text_changed boolean;
begin
  if tg_op = 'DELETE' then
    if (old.problems || old.customer_issues || old.stock_issues || old.follow_ups || old.notes) <> '' then
      insert into public.staff_day_report_versions
        (report_id, staff_id, business_date, status, reason, problems, customer_issues,
         stock_issues, follow_ups, notes, submitted_at, replaced_by)
      values
        (old.id, old.staff_id, old.business_date, old.status, 'discarded', old.problems, old.customer_issues,
         old.stock_issues, old.follow_ups, old.notes, old.submitted_at, auth.uid());
    end if;
    return old;
  end if;

  v_text_changed := new.problems        is distinct from old.problems
                 or new.customer_issues is distinct from old.customer_issues
                 or new.stock_issues    is distinct from old.stock_issues
                 or new.follow_ups      is distinct from old.follow_ups
                 or new.notes           is distinct from old.notes;
  if v_text_changed
     and (old.problems || old.customer_issues || old.stock_issues || old.follow_ups || old.notes) <> '' then
    insert into public.staff_day_report_versions
      (report_id, staff_id, business_date, status, reason, problems, customer_issues,
       stock_issues, follow_ups, notes, submitted_at, replaced_by)
    values
      (old.id, old.staff_id, old.business_date, old.status, 'edited', old.problems, old.customer_issues,
       old.stock_issues, old.follow_ups, old.notes, old.submitted_at, auth.uid());
  end if;
  return new;
end;
$$;
revoke all on function public.kt_keep_day_report_version() from public, anon, authenticated;

drop trigger if exists staff_day_reports_keep_version on public.staff_day_reports;
create trigger staff_day_reports_keep_version
  before update or delete on public.staff_day_reports
  for each row execute function public.kt_keep_day_report_version();

/* Every kept version of one person's report for one day. Keyed by person and
   day rather than by report row: a discarded draft's row is gone (report_id
   is null on its versions), and a report started again for the same day is
   a new row, so a report id cannot reach them. Same visibility as the
   reports themselves: supervisors and above see anyone's (as in
   admin_day_reports), a handler only their own. */
create or replace function public.admin_day_report_versions(p_staff_id uuid, p_day date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_current uuid;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;
  if p_staff_id is null or p_day is null then
    raise exception 'Choose a person and a day' using errcode = '22023';
  end if;
  if not public.is_supervisor() and p_staff_id is distinct from auth.uid() then
    raise exception 'You can only see your own report history' using errcode = '42501';
  end if;

  select id into v_current
    from public.staff_day_reports
   where staff_id = p_staff_id and business_date = p_day;

  return jsonb_build_object(
    'staff_id', p_staff_id,
    'business_date', p_day,
    'current_report_id', v_current,
    'versions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', v.id, 'report_id', v.report_id,
               /* false: the text belonged to a row that no longer exists
                  (a discarded draft, or a report since started again). */
               'of_current', v.report_id is not distinct from v_current and v_current is not null,
               'status', v.status, 'reason', v.reason,
               'problems', v.problems, 'customer_issues', v.customer_issues,
               'stock_issues', v.stock_issues, 'follow_ups', v.follow_ups, 'notes', v.notes,
               'submitted_at', v.submitted_at, 'replaced_at', v.replaced_at)
             order by v.replaced_at desc, v.id desc)
        from public.staff_day_report_versions v
       where v.staff_id = p_staff_id
         and v.business_date = p_day), '[]'::jsonb));
end;
$$;
revoke all on function public.admin_day_report_versions(uuid, date) from public, anon;
grant execute on function public.admin_day_report_versions(uuid, date) to authenticated;

/* ---- 1b. The team list can reach kept versions ------------------------------
   As 0054, plus each person's kept-version count, and people whose only text
   for the day is a discarded draft. Team figures (expected / submitted /
   outstanding / follow-up) are computed exactly as before. Still supervisors
   and above only. */
create or replace function public.admin_day_reports(p_day date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  v_from  timestamptz;
  v_to    timestamptz;
  v_date  date;
  v_rows  jsonb;
  v_exp   integer := 0;
  v_sub   integer := 0;
  v_flag  integer := 0;
begin
  if not public.is_supervisor() then
    raise exception 'Supervisor access required' using errcode = '42501';
  end if;

  v_from := case when p_day is null then public.kt_today_start()
                 else (p_day::timestamp at time zone 'Africa/Lagos') end;
  v_to := v_from + interval '1 day';
  v_date := (v_from at time zone 'Africa/Lagos')::date;

  with worked as (
    select distinct h.created_by as staff_id
      from public.order_status_history h
     where h.created_by is not null
       and h.created_at >= v_from and h.created_at < v_to
  ),
  reported as (
    select r.staff_id from public.staff_day_reports r where r.business_date = v_date
  ),
  people as (
    select staff_id from worked union select staff_id from reported
  ),
  /* 0087: earlier versions kept for this day. Someone whose only text is a
     discarded draft has no report row and may have moved no orders; they are
     listed so the draft can be read, but not counted in the team figures. */
  kept as (
    select v.staff_id, count(*) as n
      from public.staff_day_report_versions v
     where v.business_date = v_date
     group by v.staff_id
  ),
  everyone as (
    select staff_id, true as counted from people
    union all
    select k.staff_id, false from kept k
     where not exists (select 1 from people pe where pe.staff_id = k.staff_id)
  ),
  joined as (
    select pe.staff_id,
           nullif(btrim(coalesce(pr.display_name, '')), '') as name,
           pr.role,
           (pr.role in ('staff', 'supervisor'))             as expected,
           public.kt_staff_day_activity(pe.staff_id, v_from, v_to) as activity,
           pe.counted,
           coalesce(k.n, 0)                                  as versions,
           r.id, r.status, r.submitted_at, r.reviewed_at, r.needs_follow_up,
           r.problems, r.customer_issues, r.stock_issues, r.follow_ups,
           r.notes, r.review_note, r.reviewed_by
      from everyone pe
      left join kept k on k.staff_id = pe.staff_id
      left join public.profiles pr on pr.id = pe.staff_id
      left join public.staff_day_reports r
             on r.staff_id = pe.staff_id and r.business_date = v_date
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'staff_id',        j.staff_id,
           'name',            j.name,
           'role',            j.role,
           'expected',        j.expected,
           'activity',        j.activity,
           'versions',        j.versions,
           'report', case when j.id is null then null else jsonb_build_object(
             'id',              j.id,
             'status',          j.status,
             'submitted_at',    j.submitted_at,
             'reviewed_at',     j.reviewed_at,
             'reviewed_by',     j.reviewed_by,
             'needs_follow_up', j.needs_follow_up,
             'problems',        j.problems,
             'customer_issues', j.customer_issues,
             'stock_issues',    j.stock_issues,
             'follow_ups',      j.follow_ups,
             'notes',           j.notes,
             'review_note',     j.review_note) end)
         order by (j.status = 'submitted') nulls first, j.name), '[]'::jsonb),
         count(*) filter (where j.expected and j.counted),
         count(*) filter (where j.expected and j.status = 'submitted'),
         count(*) filter (where j.needs_follow_up)
    into v_rows, v_exp, v_sub, v_flag
    from joined j;

  return jsonb_build_object(
    'business_date', v_date,
    'generated_at',  now(),
    'viewer_role',   public.auth_role(),
    'team', jsonb_build_object(
      'expected',    v_exp,
      'submitted',   v_sub,
      'outstanding', greatest(0, v_exp - v_sub),
      'follow_up',   v_flag),
    /* Reused, not recomputed. */
    'operations', public.admin_order_activity(p_day) -> 'orders',
    'scoops',     public.admin_scoop_report(p_day),
    'inventory',  public.admin_inventory_day(p_day),
    'people',     v_rows);
end;
$$;
revoke all on function public.admin_day_reports(date) from public, anon;
grant execute on function public.admin_day_reports(date) to authenticated;

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

/* As 0052, plus 'editable', 'late_open_until' and 'versions' (count, at the
   top level and on the report). */
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
                            /* date + time -> timestamp (04:00 Lagos wall
                               clock) -> timestamptz */
                            then (((public.kt_today_start() at time zone 'Africa/Lagos')::date + time '04:00')
                                  at time zone 'Africa/Lagos') end,
    /* Every kept version for this day, including discarded drafts. */
    'versions',      (select count(*) from public.staff_day_report_versions v
                       where v.staff_id = v_uid and v.business_date = v_date),
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
      'versions',        (select count(*) from public.staff_day_report_versions v
                           where v.staff_id = v_uid and v.business_date = v_date)) end);
end;
$$;
revoke all on function public.staff_day_report(date) from public, anon;
grant execute on function public.staff_day_report(date) to authenticated;

/* ---- 3. Safety check: one entry point each, no direct writes --------------
   staff_day_report_save(text x5, boolean, date) and
   staff_day_report_discard(date) have had these exact signatures since
   0052 / 0053, so the CREATE OR REPLACEs above replace them in place: no
   older overload is left behind for PostgREST to resolve to, and nothing
   needs dropping. This block proves it at apply time: if any other
   overload of these functions exists, or a client role can write
   staff_day_reports directly (which would skip the 04:00 rule), the whole
   migration is rolled back instead of half-applied. */
do $guard$
declare
  v_name  text;
  v_sig   text;
  v_n     integer;
  v_want  text[][] := array[
    ['staff_day_report_save',     'staff_day_report_save(text,text,text,text,text,boolean,date)'],
    ['staff_day_report_discard',  'staff_day_report_discard(date)'],
    ['staff_day_report',          'staff_day_report(date)'],
    ['admin_day_reports',         'admin_day_reports(date)'],
    ['admin_day_report_versions', 'admin_day_report_versions(uuid,date)'],
    ['kt_report_day_open',        'kt_report_day_open(date)']];
begin
  for i in 1 .. array_length(v_want, 1) loop
    v_name := v_want[i][1];
    select count(*), min(p.oid::regprocedure::text) into v_n, v_sig
      from pg_proc p
     where p.proname = v_name
       and p.pronamespace = 'public'::regnamespace;
    if v_n <> 1 or v_sig <> v_want[i][2] then
      raise exception '0087 aborted: expected exactly %, found % function(s) named % (%)',
        v_want[i][2], v_n, v_name, v_sig;
    end if;
  end loop;

  if exists (select 1 from information_schema.role_table_grants
              where table_schema = 'public' and table_name in ('staff_day_reports', 'staff_day_report_versions')
                and grantee in ('anon', 'authenticated', 'PUBLIC')
                and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')) then
    raise exception '0087 aborted: a client role can write end-of-day reports directly';
  end if;
end
$guard$;

commit;
