-- ============================================================================
-- Kandy's Treats V2 — 0001 schema
-- ----------------------------------------------------------------------------
-- Tables, indexes and triggers. No RLS here; policies live in 0002_rls.sql so
-- the security model can be read in one piece.
--
-- Conventions used throughout:
--   * Money is INTEGER whole naira. Every price and fee in the current app is
--     a whole naira, so this is lossless against the existing Firestore data
--     and removes float rounding from the system entirely.
--   * snake_case columns. The service layer maps them to the camelCase shapes
--     the existing UI already expects, so no page or component changes.
--   * legacy_firestore_id columns exist purely so the Phase 2 copy can join
--     old data to new rows. They are nullable and unused at runtime.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER on purpose: this is called from RLS policies on `profiles`
-- itself, so it must bypass RLS or the policy would recurse into itself.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.profiles
     where id = auth.uid()
       and role in ('staff', 'admin', 'owner')
  );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles  (1:1 with auth.users — email lives in auth.users, not duplicated)
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text        not null default '',
  phone        text        not null default '',
  photo_url    text        not null default '',
  role         text        not null default 'customer'
                 check (role in ('customer', 'staff', 'admin', 'owner')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- A customer may never change their own role. Enforced here rather than in a
-- policy because WITH CHECK cannot see the previous row.
create or replace function public.protect_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role and not public.is_admin() then
    new.role := old.role;
  end if;
  return new;
end;
$$;

create trigger profiles_protect_role
  before update on public.profiles
  for each row execute function public.protect_profile_role();

-- ---------------------------------------------------------------------------
-- wallets  (balance is server-controlled; see 0002 grants)
-- ---------------------------------------------------------------------------

create table if not exists public.wallets (
  user_id           uuid primary key references public.profiles (id) on delete cascade,
  currency          text        not null default 'NGN',
  balance           integer     not null default 0 check (balance >= 0),
  locked_balance    integer     not null default 0 check (locked_balance >= 0),
  -- derived, so it can never drift out of step with balance
  available_balance integer generated always as (balance - locked_balance) stored,
  status            text        not null default 'active'
                      check (status in ('active', 'frozen')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger wallets_set_updated_at
  before update on public.wallets
  for each row execute function public.set_updated_at();

-- Every new auth user gets a profile and a zero-balance wallet, atomically.
-- This replaces the ensureCustomerAccount Cloud Function outright.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, phone, photo_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name',
             new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.raw_user_meta_data ->> 'phone', ''),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', '')
  )
  on conflict (id) do nothing;

  insert into public.wallets (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------

-- Text ids ('foods', 'proteins', …) match the ids the existing frontend
-- already uses in KT.menu.categories, so category links keep working as-is.
create table if not exists public.categories (
  id         text primary key,
  name       text    not null,
  section    text    not null,
  blurb      text    not null default '',
  image_key  text,
  sort_order integer not null default 0,
  active     boolean not null default true
);

create table if not exists public.menu_items (
  id                   uuid primary key default gen_random_uuid(),
  legacy_firestore_id  text unique,
  slug                 text unique,
  name                 text    not null,
  blurb                text    not null default '',
  description          text    not null default '',
  price                integer not null check (price >= 0),
  category_id          text    references public.categories (id) on delete set null,
  section              text    not null default '',
  status               text    not null default 'available'
                         check (status in ('available', 'sold_out', 'hidden')),
  -- image_key replaces the runtime name-matching heuristic in js/data/menu.js:
  -- the join is resolved once, here, instead of on every page load.
  image_key            text,
  image_url            text,
  -- drives the takeaway packaging fee; the exact rule is applied by the
  -- checkout RPC in Phase 5, not by the browser.
  pack_class           text check (pack_class in ('standard', 'ofada', 'beans')),
  rating               numeric(2,1) not null default 0,
  rating_count         integer not null default 0,
  tags                 text[]  not null default '{}',
  is_featured          boolean not null default false,
  -- the whole quickPicks collection collapses to this one flag
  is_quick_pick        boolean not null default false,
  sort_order           integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create trigger menu_items_set_updated_at
  before update on public.menu_items
  for each row execute function public.set_updated_at();

create index if not exists menu_items_category_idx on public.menu_items (category_id, sort_order);
create index if not exists menu_items_status_idx   on public.menu_items (status) where status = 'available';
create index if not exists menu_items_quick_idx    on public.menu_items (is_quick_pick) where is_quick_pick;

create table if not exists public.coupons (
  code         text primary key,
  label        text    not null default '',
  type         text    not null check (type in ('percent', 'fixed')),
  value        integer not null check (value > 0),
  min_subtotal integer not null default 0,
  active       boolean not null default true,
  expires_at   timestamptz,
  created_at   timestamptz not null default now()
);

create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text    not null default '',
  body       text    not null,
  active     boolean not null default true,
  starts_at  timestamptz,
  ends_at    timestamptz,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- Delivery fee, processing rate and packaging amounts live here so a price
-- change is a row update, not a code deploy in two places.
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Customer-owned data
-- ---------------------------------------------------------------------------

create table if not exists public.addresses (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  label          text not null default 'Delivery address',
  recipient_name text not null,
  phone          text not null,
  address        text not null check (length(btrim(address)) >= 8),
  notes          text not null default '',
  is_default     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists addresses_user_idx on public.addresses (user_id, created_at desc);

-- The hard guarantee: at most one default per customer.
create unique index if not exists addresses_one_default_per_user
  on public.addresses (user_id) where is_default;

-- The friendly half: setting a new default clears the old one instead of
-- raising a unique violation at the customer.
create or replace function public.clear_other_default_addresses()
returns trigger
language plpgsql
as $$
begin
  if new.is_default then
    update public.addresses
       set is_default = false
     where user_id = new.user_id
       and id <> new.id
       and is_default;
  end if;
  return new;
end;
$$;

create trigger addresses_single_default
  before insert or update of is_default on public.addresses
  for each row when (new.is_default) execute function public.clear_other_default_addresses();

create trigger addresses_set_updated_at
  before update on public.addresses
  for each row execute function public.set_updated_at();

create table if not exists public.favourites (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  menu_item_id uuid not null references public.menu_items (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (user_id, menu_item_id)
);

create table if not exists public.reviews (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  menu_item_id uuid not null references public.menu_items (id) on delete cascade,
  -- order_id FK is added in 0002 once public.orders exists
  order_id     uuid,
  rating       smallint not null check (rating between 1 and 5),
  comment      text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, menu_item_id)
);

create index if not exists reviews_item_idx on public.reviews (menu_item_id);

create trigger reviews_set_updated_at
  before update on public.reviews
  for each row execute function public.set_updated_at();

create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  type       text not null default 'general',
  title      text not null,
  message    text not null default '',
  related_id text,
  read       boolean not null default false,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

create table if not exists public.support_tickets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  subject    text not null,
  message    text not null,
  status     text not null default 'open'
               check (status in ('open', 'answered', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists support_tickets_user_idx on public.support_tickets (user_id, created_at desc);

create trigger support_tickets_set_updated_at
  before update on public.support_tickets
  for each row execute function public.set_updated_at();

-- Public contact form. No user_id: it is reachable while signed out.
create table if not exists public.contact_messages (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  phone      text not null,
  message    text not null,
  status     text not null default 'new'
               check (status in ('new', 'read', 'answered')),
  source     text not null default 'website',
  created_at timestamptz not null default now()
);
