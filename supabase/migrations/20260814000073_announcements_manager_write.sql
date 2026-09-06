/* ==========================================================================
   Phase 12 (Part 3B) — publishing to the storefront becomes a manager act
   --------------------------------------------------------------------------
   public.announcements is the CUSTOMER promo strip. Every visitor reads it,
   signed out included, and after Phase 12 it is a scrolling ticker rather
   than two static lines — so a row written here is the most widely-read text
   the business publishes.

   Its write policies have used is_admin() since 0005. That helper has meant
   STAFF AND ABOVE since 0037, so the effective grant has been rank 20, not
   rank 30. This was verified empirically during the Phase 12 audit, not
   inferred: a staff token issuing a PATCH against this table returned HTTP
   204 while the same request as anon returned 401. The probe matched zero
   rows, so nothing was written — but the door was open.

   Nobody chose that. It is the ordinary consequence of a helper whose name
   reads like one tier and whose body means another, and it is exactly the
   kind of drift that only shows up when someone goes looking.

   THE DECISION
   ------------
   Owner and admin may publish. Supervisor, staff, customer and anon may not.
   Publishing to the storefront is a brand decision rather than a floor one,
   and the supervisor tier exists to run a shift.

   is_manager() is admin (30) + owner (40) — the same helper that already
   guards refunds, wallet adjustments and staff flags. Reusing it keeps the
   "who speaks for the business" boundary in one place instead of inventing
   a fourth spelling of it here.

   READ IS UNTOUCHED
   -----------------
   announcements_read stays exactly as 0005 wrote it: anon and authenticated
   both see active, in-window rows, and a manager additionally sees the rest
   so the admin screen can list drafts and expired items. This migration
   narrows WRITES only. A customer's experience of the strip does not change
   by one character.

   ROLLBACK
   --------
   Drop the three policies below and re-create 0005's is_admin() versions.
   No data is touched either way — this is policy only, and the table's rows
   are not read, written or moved.
   ========================================================================== */

begin;

/* The old grant, by its old names. Dropped rather than replaced so a stale
   policy cannot survive under a name this file does not mention. */
drop policy if exists announcements_admin_insert on public.announcements;
drop policy if exists announcements_admin_update on public.announcements;
drop policy if exists announcements_admin_delete on public.announcements;

/* 0003 created an even earlier combined policy before 0005 split it. It is
   almost certainly already gone; dropping it if-exists costs nothing and
   removes the only way a staff-level write could survive this migration. */
drop policy if exists announcements_admin_write on public.announcements;

create policy announcements_manager_insert on public.announcements
  for insert to authenticated
  with check ((select public.is_manager()));

create policy announcements_manager_update on public.announcements
  for update to authenticated
  using ((select public.is_manager()))
  with check ((select public.is_manager()));

create policy announcements_manager_delete on public.announcements
  for delete to authenticated
  using ((select public.is_manager()));

comment on table public.announcements is
  'The customer-facing promo ticker. Read by everyone including anon when a '
  'row is active and inside its schedule window; written by admin and owner '
  'only (is_manager) as of Phase 12. Not to be confused with '
  'public.staff_announcements, which is the internal noticeboard and has its '
  'own table, RPCs and screen.';

commit;
