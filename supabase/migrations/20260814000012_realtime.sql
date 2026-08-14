-- ---------------------------------------------------------------------------
-- Realtime, replacing the Firestore onSnapshot listeners.
--
-- Only the two tables that genuinely need live updates are published:
--   menu_items -> sold-out flips and price changes while a customer browses
--   orders     -> live order status on the tracking page
--
-- RLS still applies to realtime, so a customer receives change events only for
-- rows they are already allowed to SELECT. Publishing orders does not leak
-- another customer's order.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'menu_items') then
    alter publication supabase_realtime add table public.menu_items;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders') then
    alter publication supabase_realtime add table public.orders;
  end if;
end $$;
