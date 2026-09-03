/* ==========================================================================
   Removing the Phase 05 test announcements
   --------------------------------------------------------------------------
   Two notices were published to prove the board and the notification path
   work. They are development fixtures, not operational instructions, and the
   board has no delete — only archive — so they would otherwise sit in the
   manager's archived list forever with "PHASE 05 TEST" in the title.

   Same shape as 0055 and 0056: one-time, marker-scoped, guarded, and adding
   no delete capability to any role.

   The notifications those publications produced are left alone. They are
   real rows in a real inbox that people may already have seen, and deleting
   somebody's read history to tidy up a test would be the wrong trade.
   ========================================================================== */

begin;

do $$
declare v_marked integer; v_all integer;
begin
  select count(*) from public.staff_announcements into v_all;
  select count(*) from public.staff_announcements
   where title like 'PHASE 05 TEST%' into v_marked;
  if v_all <> v_marked then
    raise exception
      'Refusing to run: % of % announcements are not Phase 05 fixtures',
      v_all - v_marked, v_all;
  end if;
  raise notice 'Removing % test announcements', v_marked;
end $$;

delete from public.staff_announcements where title like 'PHASE 05 TEST%';

commit;
