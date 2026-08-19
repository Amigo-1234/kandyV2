-- ---------------------------------------------------------------------------
-- Audit destructive and price-changing catalogue actions.
--
-- The delete confirmation tells the operator the action "is recorded in the
-- audit log". Nothing was recording it — menu_items and categories had no
-- audit trigger at all, so that promise was false. Rather than soften the
-- wording, this makes it true: deletion is exactly the action you most want a
-- trail for.
--
-- Price changes are included because they are the other catalogue edit with
-- direct financial consequence.
--
-- Server-side callers (auth.uid() IS NULL — migrations, seeds, service_role)
-- write no audit row: there is no operator to attribute it to, and the seed
-- would otherwise log 83 spurious creations.
-- ---------------------------------------------------------------------------

create or replace function public.audit_menu_item_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    perform public.log_admin_action(
      'menu_item.delete', 'menu_items', old.id::text,
      'Deleted menu item "' || old.name || '" (' || old.price || ')',
      jsonb_build_object('name', old.name, 'price', old.price,
                         'category', old.category_id, 'status', old.status));
    return old;
  end if;

  if tg_op = 'INSERT' then
    perform public.log_admin_action(
      'menu_item.create', 'menu_items', new.id::text,
      'Created menu item "' || new.name || '" (' || new.price || ')',
      jsonb_build_object('name', new.name, 'price', new.price,
                         'category', new.category_id));
    return new;
  end if;

  if new.price is distinct from old.price then
    perform public.log_admin_action(
      'menu_item.price_change', 'menu_items', new.id::text,
      '"' || new.name || '" price ' || old.price || ' -> ' || new.price,
      jsonb_build_object('from', old.price, 'to', new.price, 'name', new.name));
  end if;

  return new;
end;
$$;

drop trigger if exists menu_items_audit on public.menu_items;
create trigger menu_items_audit
  after insert or update or delete on public.menu_items
  for each row execute function public.audit_menu_item_change();

create or replace function public.audit_category_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return old; end if;
  perform public.log_admin_action(
    'category.delete', 'categories', old.id::text,
    'Deleted category "' || old.name || '"',
    jsonb_build_object('id', old.id, 'name', old.name));
  return old;
end;
$$;

drop trigger if exists categories_audit_delete on public.categories;
create trigger categories_audit_delete
  after delete on public.categories
  for each row execute function public.audit_category_delete();
