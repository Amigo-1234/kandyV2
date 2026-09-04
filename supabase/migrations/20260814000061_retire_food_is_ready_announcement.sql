/* ==========================================================================
   Retire the "Food is ready" public announcement
   --------------------------------------------------------------------------
   public.announcements is the CUSTOMER promo strip — policy
   announcements_read grants select to anon, and js/components/navbar.js
   paints it above every page for signed-out visitors too.

   One of its three active rows reads "Food is ready". That is an individual
   order's state broadcast to everybody who opens the site: it is true for at
   most one customer at a time, unverifiable by any of the others, and it
   competes with the screen that actually knows the answer. Phase 06 made that
   screen correct — a customer's own order now says "Ready for collection" for
   pickup and tracks the delivery progression otherwise — so the banner is not
   merely wrong, it is redundant.

   WHERE IT CAME FROM

   Not from anybody typing it. All five rows share the creation timestamp
   2026-08-14T01:25:11.803906+00:00 and come from
   supabase/seed/catalogue.sql:121-125, which carried them over from the V1
   Firestore export (firestore-export.json, /anns[2]/text). It is legacy seed
   data that outlived the system it belonged to. The seed file is corrected
   alongside this migration so a fresh environment does not reintroduce it.

   DEACTIVATED, NOT DELETED

   The table already has an `active` flag and already uses it: "burger now
   available" and "We have closed for the night" are both sitting inactive.
   Deactivating is this system's own retirement mechanism, it is reversible
   from the existing admin write policy, and it keeps the row. Addressed by
   its exact id — never by a text pattern, which could match a future
   legitimate announcement.
   ========================================================================== */

begin;

do $$
declare
  v_id     uuid := 'dc88c2c7-1517-4c27-80b1-f832848cd78a';
  v_body   text;
  v_active boolean;
  v_before integer;
  v_after  integer;
begin
  select body, active into v_body, v_active
    from public.announcements where id = v_id;

  if v_body is null then
    raise notice 'Announcement % not present; nothing to do.', v_id;
    return;
  end if;

  /* Refuse if the row is not the one that was audited. An id that has been
     recycled onto different copy must not be silently switched off. */
  if v_body <> 'Food is ready' then
    raise exception 'Refusing: announcement % now reads %, not "Food is ready"', v_id, v_body;
  end if;

  if not v_active then
    raise notice 'Already inactive; nothing to do.';
    return;
  end if;

  select count(*) into v_before from public.announcements where active;

  update public.announcements set active = false where id = v_id;

  select count(*) into v_after from public.announcements where active;

  /* Exactly one row leaves the strip. */
  if v_after <> v_before - 1 then
    raise exception 'Expected active count % -> %, got %', v_before, v_before - 1, v_after;
  end if;

  raise notice 'Retired "Food is ready". Active announcements: % -> %.', v_before, v_after;
end;
$$;

commit;
