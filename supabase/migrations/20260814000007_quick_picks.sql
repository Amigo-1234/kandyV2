-- ============================================================================
-- Kandy's Treats V2 — 0007 quick picks are combos, not a flag
-- ----------------------------------------------------------------------------
-- Discovered while inspecting the live Firestore data in Phase 2.
--
-- I had modelled `quickPicks` as a single boolean on menu_items, reading it as
-- a curation flag. It is not. Each quickPicks document is a CURATED COMBO:
--   { title, description, image, priority, active, items: [{menuId, name,
--     price, qty}, ...] }
-- Six groups, 21 line items. Collapsing that to a boolean would silently throw
-- away every combo's composition, title and quantities — a destructive
-- migration disguised as a simplification.
--
-- Since the admin panel is also moving to Supabase and is what maintains these,
-- the structure has to survive. Two tables, mirroring orders/order_items.
--
-- menu_items.is_quick_pick is KEPT as a denormalised convenience for the
-- storefront rail, derived from membership of an active combo.
-- ============================================================================

create table if not exists public.quick_picks (
  id                  uuid primary key default gen_random_uuid(),
  legacy_firestore_id text unique,
  title               text not null,
  description         text not null default '',
  image_key           text,
  image_url           text,
  active              boolean not null default true,
  priority            integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger quick_picks_set_updated_at
  before update on public.quick_picks
  for each row execute function public.set_updated_at();

create table if not exists public.quick_pick_items (
  id            uuid primary key default gen_random_uuid(),
  quick_pick_id uuid not null references public.quick_picks (id) on delete cascade,
  -- nullable for the same reason as order_items: a dish can leave the menu
  menu_item_id  uuid references public.menu_items (id) on delete set null,
  -- snapshots, so a later price change does not silently restate the combo
  name          text    not null,
  unit_price    integer not null check (unit_price >= 0),
  qty           integer not null check (qty > 0),
  sort_order    integer not null default 0
);

create index if not exists quick_pick_items_parent_idx
  on public.quick_pick_items (quick_pick_id, sort_order);

alter table public.quick_picks      enable row level security;
alter table public.quick_pick_items enable row level security;

grant select on public.quick_picks, public.quick_pick_items to anon, authenticated;

create policy quick_picks_read on public.quick_picks
  for select to anon, authenticated
  using (active or (select public.is_admin()));
create policy quick_picks_admin_insert on public.quick_picks
  for insert to authenticated with check ((select public.is_admin()));
create policy quick_picks_admin_update on public.quick_picks
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy quick_picks_admin_delete on public.quick_picks
  for delete to authenticated using ((select public.is_admin()));

create policy quick_pick_items_read on public.quick_pick_items
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.quick_picks q
       where q.id = quick_pick_items.quick_pick_id
         and (q.active or (select public.is_admin()))
    )
  );
create policy quick_pick_items_admin_insert on public.quick_pick_items
  for insert to authenticated with check ((select public.is_admin()));
create policy quick_pick_items_admin_update on public.quick_pick_items
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy quick_pick_items_admin_delete on public.quick_pick_items
  for delete to authenticated using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- The live menu has a NINTH section, "Chicken & Chips", carrying 10 items.
-- The frontend's categoryForSection() silently falls back to 'specials' for
-- anything it does not recognise, which would have buried those 10 items in
-- the wrong category. Adding the category preserves them faithfully.
--
-- NOTE: js/data/menu.js still lists only 7 categories. It needs the matching
-- entry in Phase 4, or these items will render without a category label.
-- ---------------------------------------------------------------------------

insert into public.categories (id, name, section, blurb, image_key, sort_order) values
  ('chicken-chips', 'Chicken & Chips', 'Chicken & Chips',
   'Chicken and chips, boxed', 'chicken-chips', 8)
on conflict (id) do nothing;
