-- ---------------------------------------------------------------------------
-- Guests could not read the catalogue.
--
-- Six public-read policies (menu_items, categories, announcements,
-- quick_picks, quick_pick_items, coupons) are written as
-- "visible to everyone, OR to an admin regardless of visibility", so
-- evaluating them calls public.is_admin(). 0006_revoke_public_execute revoked
-- EXECUTE from PUBLIC, which took `anon` with it. Postgres then failed the
-- policy with 42501 "permission denied for function is_admin", surfacing to
-- the browser as HTTP 401 on every catalogue request.
--
-- Signed-in customers were unaffected (`authenticated` kept EXECUTE), which is
-- why this stayed invisible: a guest silently fell back to the bundled 45-item
-- snapshot instead of the live 83, KT.menu.live stayed false, and ordering was
-- therefore disabled for exactly the visitors most likely to be browsing.
--
-- Granting EXECUTE to anon is safe. is_admin() is SECURITY DEFINER and reports
-- only on the CALLER: for an anonymous request auth.uid() is null, so it
-- returns false and reveals nothing. It takes no arguments, so it cannot be
-- used to probe another account.
-- ---------------------------------------------------------------------------

grant execute on function public.is_admin() to anon;

comment on function public.is_admin is
  'True when the caller holds a staff/admin/owner role. Callable by anon (returns false) because public-read RLS policies evaluate it.';
