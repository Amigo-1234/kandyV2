-- ---------------------------------------------------------------------------
-- Storage for menu photography.
--
-- No bucket existed: the catalogue has always used `image_key` (a bundled
-- asset in assets/images/food) with `image_url` as an optional override. That
-- stays true — uploads simply fill image_url with a public Storage URL, so
-- existing items keep resolving through image_key exactly as before and
-- nothing about the storefront's image pipeline changes.
--
-- Tiers mirror menu_items itself, for the same reasons:
--   read    public   — the storefront must serve these to signed-out visitors
--   write   manager+ — uploading a photo is part of editing an item
--   delete  owner    — destructive catalogue actions are owner-only
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-images', 'menu-images', true, 5242880,
        array['image/jpeg','image/png','image/webp','image/avif'])
on conflict (id) do nothing;

/* Storage RLS lives on storage.objects, scoped by bucket_id. */

drop policy if exists menu_images_public_read on storage.objects;
create policy menu_images_public_read on storage.objects
  for select
  using (bucket_id = 'menu-images');

drop policy if exists menu_images_manager_insert on storage.objects;
create policy menu_images_manager_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'menu-images' and (select public.is_manager()));

drop policy if exists menu_images_manager_update on storage.objects;
create policy menu_images_manager_update on storage.objects
  for update to authenticated
  using (bucket_id = 'menu-images' and (select public.is_manager()))
  with check (bucket_id = 'menu-images' and (select public.is_manager()));

drop policy if exists menu_images_owner_delete on storage.objects;
create policy menu_images_owner_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'menu-images' and (select public.is_owner()));
