-- ---------------------------------------------------------------------------
-- Tier triggers must not fire for server-side callers.
--
-- enforce_menu_item_tier() and enforce_order_status_tier() gate on
-- is_manager() / is_admin(), which read auth.uid(). In a server context
-- (service_role, a migration, a psql session, a SECURITY DEFINER job)
-- auth.uid() is NULL, so those helpers return false and the trigger refuses a
-- legitimate trusted write. It surfaced immediately: a migration could not
-- correct a menu price, failing with "Staff may only change item availability".
--
-- These triggers exist to constrain BROWSER callers. When there is no
-- authenticated user there is no tier to enforce, and the caller already holds
-- a privileged database role — which is the real boundary for that path.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_menu_item_tier()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  /* Server-side caller (no JWT): trusted by virtue of its database role. */
  if auth.uid() is null then return new; end if;
  if public.is_manager() then return new; end if;

  if new.price       is distinct from old.price
     or new.name        is distinct from old.name
     or new.category_id is distinct from old.category_id
     or new.blurb       is distinct from old.blurb
     or new.description is distinct from old.description
     or new.image_key   is distinct from old.image_key
     or new.image_url   is distinct from old.image_url
     or new.is_featured is distinct from old.is_featured
     or new.sort_order  is distinct from old.sort_order then
    raise exception 'Staff may only change item availability' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_order_status_tier()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;

  if new.status is distinct from old.status
     and new.status = 'Cancelled'
     and not public.is_manager() then
    raise exception 'Only an admin or owner may cancel an order' using errcode = '42501';
  end if;
  return new;
end;
$$;
