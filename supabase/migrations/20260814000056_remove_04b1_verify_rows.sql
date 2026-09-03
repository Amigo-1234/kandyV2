/* ==========================================================================
   Removing the two rows written to verify 0055
   --------------------------------------------------------------------------
   0055 emptied the ledger of Phase 04B's fixtures. Proving it still accepted
   real entries afterwards meant writing two — a prepared and a waste, both
   noted "04B.1 verify" — and because the ledger has no delete path from the
   application, those two became fixtures of exactly the kind 0055 had just
   removed.

   So they go the same way, and the lesson is recorded here rather than
   learned again: any write made to verify this system is permanent, and
   verification after this point should read rather than write.

   Same shape as 0055 — a guard that refuses to run if anything unexpected is
   present, and no new delete capability for any role.
   ========================================================================== */

begin;

do $$
declare
  v_all integer;
  v_marked integer;
begin
  select count(*) from public.inventory_movements into v_all;
  select count(*) from public.inventory_movements
   where note = '04B.1 verify' into v_marked;

  if v_all <> v_marked then
    raise exception
      'Refusing to run: % of % movements are not the 04B.1 verification rows',
      v_all - v_marked, v_all;
  end if;
  raise notice 'Removing % verification movements', v_marked;
end $$;

delete from public.inventory_movements where note = '04B.1 verify';

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
