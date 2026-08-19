-- ---------------------------------------------------------------------------
-- Saved addresses: restrict cross-customer reads to manager+.
--
-- addresses_select_own allowed `user_id = auth.uid() OR is_admin()`, and
-- is_admin() includes STAFF. So a staff account could read any customer's home
-- address straight from the table — while admin_get_customer() deliberately
-- withholds it from them. The API said no and the table said yes, which makes
-- the restriction cosmetic: exactly the failure mode this project has been
-- guarding against everywhere else.
--
-- Tightened to is_manager(). This does NOT blind staff on deliveries: orders
-- carry address_snapshot, captured at checkout, and the Orders module reads
-- the delivery address from there rather than from this table.
--
-- Customers keep full access to their own rows (user_id = auth.uid()), so the
-- storefront address book is unaffected.
-- ---------------------------------------------------------------------------

drop policy if exists addresses_select_own on public.addresses;
create policy addresses_select_own on public.addresses
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_manager()));
