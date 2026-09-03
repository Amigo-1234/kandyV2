/* ==========================================================================
   One-time removal of the Phase 04B test fixtures
   --------------------------------------------------------------------------
   Phase 04B proved the ledger works by writing to it. Those rows were marked
   "PHASE 04B TEST" as they were created and are development fixtures, not
   business events: nobody cooked ten scoops of jollof, nobody burnt two, and
   nobody counted four cups of beans. Left in place they would have become the
   opening balance every following day carried forward, and the first real
   variance anyone looked at would have been wrong.

   WHY THIS IS A MIGRATION AND NOT A FEATURE

   The ledger is append-only for real records and stays that way. There is
   still no DELETE grant for any role — not staff, not supervisor, not owner —
   so nothing here gives anyone a way to erase history from the application.
   This runs once, as the migration role, against rows identified by the
   marker they were written with.

   It is also not done by writing compensating adjustments. A correcting
   adjustment is the right answer for a real mistake, because the mistake
   genuinely happened; these events never happened at all, and inventing
   negative movements to cancel them would leave eighteen fictional rows in
   the history instead of nine.

   The guard below refuses to run if the data does not look exactly as Phase
   04B left it, so this cannot quietly delete something else on a database
   that has moved on.
   ========================================================================== */

begin;

do $$
declare
  v_marked_moves integer;
  v_all_moves    integer;
  v_marked_counts integer;
  v_all_counts   integer;
begin
  select count(*) from public.inventory_movements into v_all_moves;
  select count(*) from public.inventory_movements
   where note like 'PHASE 04B%' into v_marked_moves;
  select count(*) from public.inventory_counts into v_all_counts;
  select count(*) from public.inventory_counts
   where note like 'PHASE 04B%' into v_marked_counts;

  /* Every row currently in both tables is a Phase 04B fixture — real
     inventory tracking has not started. If that is no longer true, a real
     record now exists and this migration must not run blind. */
  if v_all_moves <> v_marked_moves then
    raise exception
      'Refusing to run: % of % movements are unmarked and may be real records',
      v_all_moves - v_marked_moves, v_all_moves;
  end if;
  if v_all_counts <> v_marked_counts then
    raise exception
      'Refusing to run: % of % counts are unmarked and may be real records',
      v_all_counts - v_marked_counts, v_all_counts;
  end if;

  raise notice 'Removing % test movements and % test counts',
    v_marked_moves, v_marked_counts;
end $$;

/*
   Corrections reference the movement they correct, and corrects_id is
   ON DELETE RESTRICT, so the correcting rows must go first. Both are
   fixtures; both match the marker.
*/
delete from public.inventory_movements
 where note like 'PHASE 04B%'
   and corrects_id is not null;

delete from public.inventory_movements
 where note like 'PHASE 04B%';

/*
   The physical count goes with them. The brief protects REAL counts, and
   this one is not: it carries the same marker, and it is the row that would
   otherwise have become a fabricated opening balance of four cups for every
   day after it.
*/
delete from public.inventory_counts
 where note like 'PHASE 04B%';

/* Both tables should now be empty — the correct state for a ledger whose
   real tracking has not yet begun. */
do $$
declare v_m integer; v_c integer;
begin
  select count(*) from public.inventory_movements into v_m;
  select count(*) from public.inventory_counts into v_c;
  if v_m <> 0 or v_c <> 0 then
    raise exception 'Cleanup incomplete: % movements, % counts remain', v_m, v_c;
  end if;
  raise notice 'Inventory ledger is empty and ready for real records.';
end $$;

commit;
