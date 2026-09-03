/* ==========================================================================
   Discarding your own draft
   --------------------------------------------------------------------------
   0052 gave staff_day_reports a SELECT grant and nothing else, so every write
   goes through a function. That is the right shape, but it left one ordinary
   thing impossible: a handler who opens the form, types a line, and then
   decides they had nothing to report is stuck with a draft row that will show
   on the manager's list as an unfinished report all evening.

   So: delete your OWN draft, for TODAY only. Three limits, each doing work —

     own      staff_id = auth.uid(), so nobody can discard a colleague's.
     draft    a submitted report is a record. Withdrawing one is a
              conversation with a manager, not a button.
     today    yesterday's report belongs to a day that has closed.

   Not audited. Discarding an unsubmitted draft destroys nothing anyone has
   seen — the audit log records submissions and reviews, which are the events
   that carry meaning.
   ========================================================================== */

begin;

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

  if v_date <> (public.kt_today_start() at time zone 'Africa/Lagos')::date then
    raise exception 'You can only discard today''s draft' using errcode = '22023';
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

commit;
