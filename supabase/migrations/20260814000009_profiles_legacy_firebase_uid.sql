-- ---------------------------------------------------------------------------
-- profiles.legacy_firebase_uid
--
-- Records which Firebase Auth account a profile was migrated from, so the old
-- Firebase UID can still be correlated with the new Supabase UUID. Historical
-- provenance only — it is NEVER consulted for authorisation.
--
-- ADDITIVE AND NON-DESTRUCTIVE:
--   * ADD COLUMN IF NOT EXISTS, nullable, no default and no NOT NULL, so
--     PostgreSQL adds it as a catalogue-only change: no table rewrite, no row
--     is touched, every existing row simply reads NULL.
--   * The index is CREATE ... IF NOT EXISTS and partial, so it permits many
--     NULLs while forbidding two profiles claiming the same Firebase UID.
--   * No DROP, no DELETE, no UPDATE, no type change, no column removal.
--   * The grant change only REMOVES privileges from customers. It cannot
--     destroy data; it narrows what a browser session is allowed to write.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists legacy_firebase_uid text;

comment on column public.profiles.legacy_firebase_uid is
  'Firebase Auth UID this profile was migrated from (provenance only, never used for authorisation).';

create unique index if not exists profiles_legacy_firebase_uid_key
  on public.profiles (legacy_firebase_uid)
  where legacy_firebase_uid is not null;

-- A customer must not be able to rewrite their own legacy mapping. The table
-- currently carries a table-wide UPDATE grant, and PostgreSQL cannot revoke a
-- single column while that exists, so replace it with an explicit column list.
-- This also stops a customer touching id / role / created_at at the grant
-- level, reinforcing the existing protect_profile_role() trigger.
revoke update on public.profiles from authenticated;
grant update (display_name, phone, photo_url, updated_at)
  on public.profiles to authenticated;
