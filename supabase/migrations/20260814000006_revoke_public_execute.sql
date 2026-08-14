-- ============================================================================
-- Kandy's Treats V2 — 0006 close the PUBLIC EXECUTE grant on functions
-- ----------------------------------------------------------------------------
-- 0005 revoked EXECUTE from `anon` and `authenticated` and the advisor still
-- flagged all three functions. The reason: Postgres grants EXECUTE to PUBLIC
-- on every new function by default, and both roles inherit it. Revoking a
-- privilege a role never held directly is a no-op, so the REST endpoints
-- stayed reachable.
--
-- The fix is to revoke from PUBLIC, then grant back only what is genuinely
-- required.
-- ============================================================================

revoke execute on function public.handle_new_user()      from public;
revoke execute on function public.protect_profile_role() from public;
revoke execute on function public.is_admin()             from public;

-- RLS policy expressions are evaluated as the querying role, so `authenticated`
-- must keep EXECUTE on is_admin() or every admin policy fails with permission
-- denied. `anon` is deliberately not granted: no policy reachable by anon calls
-- it. The two trigger functions need no grant at all — the trigger mechanism
-- does not consult the caller's EXECUTE privilege.
grant execute on function public.is_admin() to authenticated;
