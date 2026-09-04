/* ==========================================================================
   One-time: remove the two "FORGED" announcements from the 05.1 security test
   --------------------------------------------------------------------------
   The Phase 05.1 permission matrix proves who may publish by having every
   role attempt it. Two of those attempts are SUPPOSED to succeed — admin and
   owner — so the test necessarily creates two real rows, archives them, and
   leaves them in the manager's archived list titled "FORGED".

   They are development fixtures. The board offers archive and not delete, on
   purpose, so this is the same one-time scoped statement that 0055, 0056 and
   0058 used: a migration runs as the migration role, and no role gains a
   delete capability it keeps.

   Scoped by title AND body AND status together, and guarded so it cannot run
   if anything else matches. The real owner's "Cheap Meal" notice is not
   touched by any of those predicates.
   ========================================================================== */

begin;

do $$
declare
  v_target integer;
  v_real   integer;
  v_gone   integer;
begin
  select count(*) into v_target
    from public.staff_announcements
   where title = 'FORGED' and body = 'forged' and status = 'archived';

  select count(*) into v_real
    from public.staff_announcements
   where not (title = 'FORGED' and body = 'forged' and status = 'archived');

  if v_target = 0 then
    raise notice 'No FORGED test announcements present; nothing to do.';
    return;
  end if;

  /* The test creates exactly two — one for admin, one for owner. Anything
     else means the predicate is catching something it should not. */
  if v_target <> 2 then
    raise exception 'Expected exactly 2 FORGED test rows, found %', v_target;
  end if;

  delete from public.staff_announcements
   where title = 'FORGED' and body = 'forged' and status = 'archived';
  get diagnostics v_gone = row_count;

  raise notice 'Removed % forged test announcements; % real announcement(s) untouched.',
    v_gone, v_real;
end;
$$;

commit;
