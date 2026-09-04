/* ==========================================================================
   One-time: remove the Phase 05 test announcement notifications
   --------------------------------------------------------------------------
   Development fixtures only. Nothing here changes how notifications work and
   no DELETE grant is added — a migration runs as the migration role, so this
   is a single scoped statement rather than a new capability anybody keeps.

   WHAT THE BRIEF EXPECTED, AND WHAT IS ACTUALLY THERE

   The instruction described "two test internal announcements which generated
   two admin_announcement notification records". Two things differ, and both
   matter enough to be written down rather than quietly worked around:

     1. It is five rows, not one, per announcement. notify_roles() writes ONE
        ROW PER RECIPIENT — that is the whole design of the pipeline — so one
        published notice reached all five handler accounts.

     2. Only ONE of the two announcements was a fixture. The second, "Cheap
        Meal" (id 14344a19-8e84-4e30-97b6-78dd7c4760a2, body "Today for cheap
        meal"), was published by the REAL owner account 0c9f1b5a at
        2026-09-03 23:52:08 — a genuine operational notice sent through the
        feature, confirmed in admin_audit_log. Its five notifications are real
        business records and are deliberately left alone.

   So this deletes exactly the five rows belonging to the one test
   announcement, addressed by its id rather than by a text pattern, so it
   cannot widen. Its parent staff_announcements row was already removed by
   migration 0058 at the end of Phase 05 — that migration deliberately left
   these notifications alone, reasoning that deleting somebody's inbox history
   to tidy a test was the wrong trade. Phase 05.1 asks for them to go, so they
   go, but only the fixture's own five.
   ========================================================================== */

begin;

do $$
declare
  v_test uuid := '64601f06-7c94-4f6c-b2ce-85069a4d1994';
  v_real uuid := '14344a19-8e84-4e30-97b6-78dd7c4760a2';
  v_before integer;
  v_deleted integer;
  v_real_kept integer;
  v_other integer;
begin
  select count(*) into v_before
    from public.notifications where type = 'admin_announcement';

  /* Refuse to run if the shape is not what was verified. Better to fail the
     migration than to delete something unexamined. */
  if not exists (select 1 from public.notifications
                  where type = 'admin_announcement' and related_id = v_test::text) then
    raise notice 'Phase 05 test notifications already removed; nothing to do.';
    return;
  end if;

  delete from public.notifications
   where type = 'admin_announcement'
     and related_id = v_test::text;
  get diagnostics v_deleted = row_count;

  select count(*) into v_real_kept
    from public.notifications
   where type = 'admin_announcement' and related_id = v_real::text;

  select count(*) into v_other
    from public.notifications where type <> 'admin_announcement';

  raise notice 'admin_announcement before: %, deleted: %, real "Cheap Meal" kept: %, other types untouched: %',
    v_before, v_deleted, v_real_kept, v_other;

  /* The real owner's notice must survive this. If it did not, stop. */
  if v_real_kept <> 5 then
    raise exception 'Expected the 5 real "Cheap Meal" notifications to remain, found %', v_real_kept;
  end if;
end;
$$;

commit;
