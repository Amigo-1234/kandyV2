/* ==========================================================================
   Staff end-of-day reports
   --------------------------------------------------------------------------
   The human half of the end-of-day picture. Phase 02 already derives what a
   handler DID — orders touched, picked up, completed, cancelled, first and
   last action — from order_status_history. None of that is asked for here.
   This table holds only what a query cannot know: what went wrong, what a
   customer said, what was running low, what is unfinished.

   WHY THE NUMBERS ARE NOT STORED IN THIS TABLE

   A report row carries no counts at all. They are derived on read from
   order_status_history, which is append-only and day-scoped, so yesterday's
   figures are already stable — an order cancelled tomorrow lands in
   tomorrow's window, not yesterday's. Snapshotting them would create a
   second copy that could disagree with the history beneath it, and would
   also be a set of numbers sitting on a row a staff member can write to.
   Deriving them makes "staff cannot edit the automatic values" true by
   construction rather than by policy.

   WHY THE STATUS MODEL IS TWO AXES, NOT ONE ENUM

   The brief suggested Not submitted / Draft / Submitted / Reviewed /
   Requires follow-up. Three of those are things a MANAGER does to a report
   and two are things its AUTHOR does, and they are not mutually exclusive —
   a reviewed report can still require follow-up. Collapsing them into one
   column would force a choice between those two facts. So:

     status            the author's own lifecycle: draft -> submitted
     reviewed_at/by    the manager looked at it
     needs_follow_up   the manager flagged it, independently of the above

   "Not submitted" is then the absence of a submitted row, which is also how
   the manager's list finds it.
   ========================================================================== */

begin;

create table if not exists public.staff_day_reports (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid not null references public.profiles (id) on delete cascade,
  /* The Africa/Lagos business date, not a UTC calendar date — a report filed
     at 00:30 Lagos belongs to the day that just ended everywhere else in the
     admin too. */
  business_date date not null,

  status        text not null default 'draft' check (status in ('draft', 'submitted')),

  /* ---- The human half. Five fields, not eight. ------------------------
     The brief listed eight prompts; several ask the same question in
     different words, and a handler filling this in on a phone at the end of
     a shift will not distinguish "problems" from "incidents" or "delivery
     issues". These five cover all of them and are the ones a manager can
     act on differently:

       problems         anything that went wrong — including delivery,
                        pickup and equipment trouble, and incidents
       customer_issues  complaints and customer problems, which get handled
                        differently from operational ones
       stock_issues     what ran low or out. A written observation only —
                        stock quantities are a later phase and this field
                        must not become a counting exercise
       follow_ups       what is unresolved and carries into tomorrow
       notes            anything else management should know
  */
  problems        text not null default '',
  customer_issues text not null default '',
  stock_issues    text not null default '',
  follow_ups      text not null default '',
  notes           text not null default '',

  submitted_at  timestamptz,

  /* ---- Management review, kept strictly apart from the author's words --
     A review never edits the report. It is recorded beside it. */
  reviewed_at     timestamptz,
  reviewed_by     uuid references public.profiles (id) on delete set null,
  review_note     text not null default '',
  needs_follow_up boolean not null default false,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  /* One report per person per business day. */
  constraint staff_day_reports_one_per_day unique (staff_id, business_date)
);

create index if not exists staff_day_reports_date_idx
  on public.staff_day_reports (business_date desc);

create trigger staff_day_reports_set_updated_at
  before update on public.staff_day_reports
  for each row execute function public.set_updated_at();

/* ---- Access -----------------------------------------------------------
   SELECT only. Every write goes through a SECURITY DEFINER function below,
   which is what makes "a staff member cannot mark their own report
   reviewed", "cannot edit somebody else's", and "cannot backdate
   submitted_at" true at the grant level rather than by hoping the UI
   behaves. There is deliberately no INSERT, UPDATE or DELETE grant.
*/
alter table public.staff_day_reports enable row level security;
revoke all on public.staff_day_reports from anon, authenticated;
grant select on public.staff_day_reports to authenticated;

create policy staff_day_reports_select on public.staff_day_reports
  for select to authenticated
  using (staff_id = (select auth.uid()) or (select public.is_supervisor()));

/* ---- One definition of "what this person did" ------------------------- */

/*
   Extracted so the handler's own page and the manager's list cannot drift
   apart: both read this, and admin_order_activity() is rewritten below to
   build its per-person breakdown from it too. One definition, three callers.

   Internal — callers are all SECURITY DEFINER functions that have already
   decided who may see the result.
*/
create or replace function public.kt_staff_day_activity(
  p_staff uuid, p_from timestamptz, p_to timestamptz
) returns jsonb language sql stable security definer set search_path = public as $$
  with acts as (
    /* Handler actions only. Checkout writes the opening 'New' row with a
       null created_by, and so do the payment flows — filtering on
       created_by is what separates a person from the system. */
    select h.order_id, h.status, h.created_at
      from public.order_status_history h
     where h.created_by = p_staff
       and h.created_at >= p_from
       and h.created_at <  p_to
  ),
  pickup as (
    /* Who took each order on: the actor of its first move away from New,
       across all time, so an order carried over from yesterday is still
       credited to whoever picked it up. */
    select distinct on (h.order_id) h.order_id, h.created_by
      from public.order_status_history h
     where h.created_by is not null
       and h.status <> 'New'
     order by h.order_id, h.created_at
  )
  select jsonb_build_object(
    'orders_touched',   (select count(distinct order_id) from acts),
    'orders_picked_up', (select count(*) from pickup p
                          where p.created_by = p_staff
                            and p.order_id in (select order_id from acts)),
    'orders_completed', (select count(*) from acts where status = 'Completed'),
    'orders_cancelled', (select count(*) from acts where status = 'Cancelled'),
    'status_changes',   (select count(*) from acts),
    'first_action_at',  (select min(created_at) from acts),
    'last_action_at',   (select max(created_at) from acts));
$$;

revoke all on function public.kt_staff_day_activity(uuid, timestamptz, timestamptz)
  from public, anon, authenticated;

/* Phase 02's RPC now builds its breakdown from the same helper, so the
   manager's list and a handler's own page can never disagree. Totals and
   tiering are unchanged. */
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

  v_from := case
              when p_day is null then public.kt_today_start()
              else (p_day::timestamp at time zone 'Africa/Lagos')
            end;
  v_to := v_from + interval '1 day';

  select jsonb_build_object(
           'received',  count(*) filter (where o.created_at >= v_from and o.created_at < v_to),
           'pending',   count(*) filter (where o.created_at >= v_from and o.created_at < v_to
                                           and o.status not in ('Completed', 'Cancelled')),
           'unattended', count(*) filter (where o.created_at >= v_from and o.created_at < v_to
                                            and o.status = 'New'
                                            and not exists (
                                              select 1 from public.order_status_history h
                                               where h.order_id = o.id
                                                 and h.created_by is not null)),
           'completed', (select count(distinct h.order_id) from public.order_status_history h
                          where h.status = 'Completed'
                            and h.created_at >= v_from and h.created_at < v_to),
           'cancelled', (select count(distinct h.order_id) from public.order_status_history h
                          where h.status = 'Cancelled'
                            and h.created_at >= v_from and h.created_at < v_to))
    into v_ord
    from public.orders o;

  if v_sup then
    select coalesce(jsonb_agg(
             public.kt_staff_day_activity(a.created_by, v_from, v_to)
             || jsonb_build_object(
                  'staff_id', a.created_by,
                  'name',     nullif(btrim(coalesce(p.display_name, '')), ''),
                  'role',     p.role)
             order by (public.kt_staff_day_activity(a.created_by, v_from, v_to) ->> 'orders_touched')::int desc,
                      p.display_name), '[]'::jsonb)
      into v_staff
      from (select distinct h.created_by
              from public.order_status_history h
             where h.created_by is not null
               and h.created_at >= v_from and h.created_at < v_to) a
      left join public.profiles p on p.id = a.created_by;
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

/* ---- A handler's own end-of-day page ---------------------------------- */

create or replace function public.staff_day_report(p_day date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_from timestamptz;
  v_to   timestamptz;
  v_rep  public.staff_day_reports;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  v_from := case when p_day is null then public.kt_today_start()
                 else (p_day::timestamp at time zone 'Africa/Lagos') end;
  v_to := v_from + interval '1 day';

  select * into v_rep
    from public.staff_day_reports
   where staff_id = v_uid
     and business_date = (v_from at time zone 'Africa/Lagos')::date;

  return jsonb_build_object(
    'business_date', (v_from at time zone 'Africa/Lagos')::date,
    'staff_id',      v_uid,
    'role',          public.auth_role(),
    /* Derived, never stored, never editable. */
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
      /* The author sees that a manager has looked, and any note left for
         them — but cannot change either. */
      'reviewed_at',     v_rep.reviewed_at,
      'review_note',     v_rep.review_note,
      'needs_follow_up', v_rep.needs_follow_up) end);
end;
$$;

revoke all on function public.staff_day_report(date) from public, anon;
grant execute on function public.staff_day_report(date) to authenticated;

/* ---- Saving and submitting one's own report --------------------------- */

/*
   The only write path a handler has. It can reach five text columns on one
   row — their own, for one date — and nothing else. submitted_at is stamped
   by the server, so it cannot be backdated; the review columns are not
   mentioned, so they cannot be set.

   A submitted report can still be edited by its author on the same business
   day: a handler who remembers something five minutes later should not have
   to ask a manager. Re-submitting refreshes submitted_at, which is the
   honest record of when the final version arrived. Past days are closed to
   editing entirely.
*/
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

  /* Only today. A report about a day that has closed is a memory, not a
     record, and back-filling one would put a timestamp on it that implies
     otherwise. */
  if v_date <> (public.kt_today_start() at time zone 'Africa/Lagos')::date then
    raise exception 'You can only write today''s report' using errcode = '22023';
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

  /* Submitting is the event worth recording. Saving a draft every few
     seconds is not, and would bury the audit log. */
  if p_submit and coalesce(v_was, 'draft') <> 'submitted' then
    perform public.log_admin_action(
      'eod.submitted', 'staff_day_reports', v_id::text,
      'End-of-day report submitted for ' || v_date::text,
      jsonb_build_object('business_date', v_date));
  end if;

  return jsonb_build_object('status', 'ok', 'id', v_id,
                            'submitted', p_submit, 'business_date', v_date);
end;
$$;

revoke all on function public.staff_day_report_save(text, text, text, text, text, boolean, date)
  from public, anon;
grant execute on function public.staff_day_report_save(text, text, text, text, text, boolean, date)
  to authenticated;

/* ---- The manager's review list ---------------------------------------- */

/*
   Answers "who has reported and who has not" without opening anything, and
   carries the day's operational totals beside it so the manager has one
   screen rather than three.

   WHO IS EXPECTED TO REPORT is derived, never a number typed in somewhere:
   a handler is expected if they DID operational work today, or already
   started a report. Someone who did not work has nothing to report, and
   inventing a roster would mean inventing attendance, which this phase is
   explicitly not building.

   Owners and admins appear with their activity — §8: management must not be
   invisible — but are not counted as outstanding, because nothing requires
   them to file a staff report.

   Operations and scoop totals come from the Phase 02 and Phase 01 functions
   rather than being recomputed here.
*/
create or replace function public.admin_day_reports(p_day date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
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
  joined as (
    select pe.staff_id,
           nullif(btrim(coalesce(pr.display_name, '')), '') as name,
           pr.role,
           /* staff and supervisors file reports; owners and admins do not
              have to, so they are shown but never counted as outstanding. */
           (pr.role in ('staff', 'supervisor'))             as expected,
           public.kt_staff_day_activity(pe.staff_id, v_from, v_to) as activity,
           r.id, r.status, r.submitted_at, r.reviewed_at, r.needs_follow_up,
           r.problems, r.customer_issues, r.stock_issues, r.follow_ups,
           r.notes, r.review_note, r.reviewed_by
      from people pe
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
         count(*) filter (where j.expected),
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
    'people',     v_rows);
end;
$$;

revoke all on function public.admin_day_reports(date) from public, anon;
grant execute on function public.admin_day_reports(date) to authenticated;

/* ---- Reviewing a report ------------------------------------------------ */

/*
   Writes only the four review columns. The author's five text fields are not
   mentioned by this function, so a review physically cannot overwrite what
   the staff member wrote.
*/
create or replace function public.admin_review_day_report(
  p_report_id      uuid,
  p_needs_follow_up boolean default false,
  p_note           text default ''
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_before jsonb;
  v_staff  uuid;
  v_date   date;
begin
  if not public.is_supervisor() then
    raise exception 'Supervisor access required' using errcode = '42501';
  end if;

  select staff_id, business_date,
         jsonb_build_object('reviewed_at', reviewed_at,
                            'needs_follow_up', needs_follow_up)
    into v_staff, v_date, v_before
    from public.staff_day_reports where id = p_report_id;

  if v_staff is null then
    raise exception 'No such report' using errcode = 'P0002';
  end if;

  update public.staff_day_reports
     set reviewed_at     = now(),
         reviewed_by     = auth.uid(),
         needs_follow_up = coalesce(p_needs_follow_up, false),
         review_note     = btrim(coalesce(p_note, ''))
   where id = p_report_id;

  perform public.log_admin_action(
    'eod.reviewed', 'staff_day_reports', p_report_id::text,
    'Reviewed the end-of-day report for ' || v_date::text ||
      case when p_needs_follow_up then ' — flagged for follow-up' else '' end,
    jsonb_build_object('from', v_before,
                       'to', jsonb_build_object('reviewed_at', now(),
                                                'needs_follow_up', coalesce(p_needs_follow_up, false)),
                       'staff_id', v_staff, 'business_date', v_date));

  return jsonb_build_object('status', 'ok', 'id', p_report_id,
                            'needs_follow_up', coalesce(p_needs_follow_up, false));
end;
$$;

revoke all on function public.admin_review_day_report(uuid, boolean, text) from public, anon;
grant execute on function public.admin_review_day_report(uuid, boolean, text) to authenticated;

commit;
