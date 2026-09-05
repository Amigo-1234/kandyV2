/* ==========================================================================
   Two stubs left by my own Phase 08B regression test
   --------------------------------------------------------------------------
   Part K re-ran the permission matrix, and the "may this role publish a staff
   announcement?" check works by actually trying it. The two roles that are
   allowed to — admin and owner — therefore each created a real announcement
   titled "x". They were archived immediately, so no handler ever saw them,
   but archived is not gone and Part L asks for no known test residue.

   staff_announcements has no DELETE grant by design: an announcement that was
   live is part of what happened that day. These two were never live, so
   removing them destroys no record of anything. Scoped by exact title AND
   draft-or-archived status AND a count assertion, so it cannot reach the
   owner's real "Cheap Meal" notice.
   ========================================================================== */

begin;

do $$
declare n integer; v_live integer;
begin
  select count(*) into n from public.staff_announcements
   where title = 'x' and status in ('draft', 'archived');
  if n <> 2 then
    raise exception 'Expected exactly 2 regression stubs, found %', n;
  end if;

  delete from public.staff_announcements
   where title = 'x' and status in ('draft', 'archived');
  get diagnostics n = row_count;
  raise notice 'regression stubs removed: %', n;

  select count(*) into n from public.staff_announcements;
  if n <> 1 then raise exception 'Expected 1 announcement left, found %', n; end if;

  select count(*) into v_live from public.staff_announcements where status = 'published';
  if v_live <> 1 then raise exception 'Expected the real published notice to remain, found %', v_live; end if;
end;
$$;

commit;
