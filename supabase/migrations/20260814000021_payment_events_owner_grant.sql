-- ---------------------------------------------------------------------------
-- payment_events: restore the SELECT grant for the owner tier.
--
-- 0015 did `revoke all ... from anon, authenticated` so no customer could read
-- raw gateway payloads. 0019 then narrowed the policy to is_owner() — but a
-- policy cannot grant what the role does not hold, so even an owner got 403.
-- RLS filters on top of grants; both are required.
--
-- The grant is broad (authenticated) and the POLICY is the boundary: it allows
-- only is_owner(). Every lower tier still gets zero rows.
-- ---------------------------------------------------------------------------

grant select on public.payment_events to authenticated;
