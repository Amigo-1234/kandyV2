/* ==========================================================================
   Phase 10 — recoverable trash + staff flags
   --------------------------------------------------------------------------
   Two management features on top of the role hierarchy, audit log and
   notification pipeline that already exist. No new auth, no second role
   system, no parallel notification path.

   WHY SOFT-DELETE COLUMNS AND NOT A GENERIC TRASH TABLE

   The brief offered a generic bin for heterogeneous records. A foreign key
   rules it out:

     order_items.menu_item_id       references menu_items  ON DELETE SET NULL
     inventory_movements.menu_item_id references menu_items ON DELETE RESTRICT

   A generic bin must physically delete the row to move it. That fires the
   SET NULL and permanently severs every historical order line from the dish
   it was — or, where inventory movements exist, fails outright on the
   RESTRICT. Restoring would insert a row with a NEW identity, and
   reattaching the old lines would mean UPDATEing paid, settled orders, which
   this phase must not do.

   Keeping the row and marking it is the only design under which restoration
   is lossless. Identity survives, history keeps pointing at it, and no order
   is ever rewritten. order_items already snapshots `name` and `unit_price`,
   so what the customer was charged was never at risk either way — but the
   link, and every report that joins through it, was.

   WHAT MAY BE TRASHED

   Exactly the two things the admin can already hard-delete: menu items and
   categories. Nothing else in the admin UI has a delete operation, so
   nothing else needs a bin; inventing one would be adding deletion, not
   making deletion safe. The allowlist lives in trash_kind() below, so
   "an order cannot be trashed" is a constraint, not a convention.

   WHO MAY DO IT

   Unchanged. menu_items_admin_delete and categories_admin_delete are both
   `using (is_owner())`, so trashing, restoring and purging stay owner-only.
   An admin may READ the bin — seeing what was removed is not a new power —
   but cannot act on it. Nobody gains a privilege they did not have.

   HOW A TRASHED DISH STOPS BEING SELLABLE

   Not by editing create_checkout_order(). That function is 220 lines of
   pricing next to money this phase is forbidden to touch. Instead trashing
   parks the row in a state checkout already refuses — status 'hidden' —
   and remembers the status it had, so restoring puts it back exactly.
   Every existing consumer (checkout, the public policy, inventory, scoop
   sales) therefore behaves correctly with no change at all.
   ========================================================================== */

begin;

/* ======================================================================
   PART A — TRASH
   ====================================================================== */

/* ---- 1. The marks ------------------------------------------------------ */

alter table public.menu_items
  add column if not exists deleted_at     timestamptz,
  add column if not exists deleted_by     uuid references public.profiles (id) on delete set null,
  add column if not exists delete_reason  text,
  /* The status to put back on restore. Without it, restoration would have to
     guess, and a dish that was deliberately sold_out would come back live. */
  add column if not exists status_before_trash text;

alter table public.categories
  add column if not exists deleted_at    timestamptz,
  add column if not exists deleted_by    uuid references public.profiles (id) on delete set null,
  add column if not exists delete_reason text;

create index if not exists menu_items_trash_idx on public.menu_items (deleted_at desc)
  where deleted_at is not null;
create index if not exists categories_trash_idx on public.categories (deleted_at desc)
  where deleted_at is not null;

comment on column public.menu_items.deleted_at is
  'Non-null means trashed: invisible to customers, unsellable, still referenced '
  'by historical order_items and inventory_movements. Restorable by the owner.';

/* ---- 2. Customers must not see a trashed dish -------------------------- */

/*
   Only the public half of this policy changes. Staff+ keep seeing every row,
   because the Trash screen has to read the rows it lists.
*/
drop policy if exists menu_items_read on public.menu_items;
create policy menu_items_read on public.menu_items
  for select to anon, authenticated
  using (
    (status <> 'hidden' and deleted_at is null)
    or (select public.is_admin())
  );

/* ---- 3. The trash columns are writable only through the RPCs ----------- */

/*
   menu_items has column-limited UPDATE grants, so a client cannot PATCH
   deleted_at there. public.categories has a whole-table UPDATE grant from
   0019, which would let a manager soft-delete one silently and unaudited.
   This trigger closes that: the marks move only inside a function that has
   set the guard flag, and every such function writes the audit log.
*/
create or replace function public.trash_marks_are_rpc_only()
returns trigger language plpgsql set search_path = public as $$
begin
  if (new.deleted_at is distinct from old.deleted_at
      or new.deleted_by is distinct from old.deleted_by
      or new.delete_reason is distinct from old.delete_reason)
     and coalesce(current_setting('kt.trash_op', true), '') <> 'on' then
    raise exception 'Use the Trash actions; the deletion marks are not directly writable'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists menu_items_trash_marks on public.menu_items;
create trigger menu_items_trash_marks before update on public.menu_items
  for each row execute function public.trash_marks_are_rpc_only();

drop trigger if exists categories_trash_marks on public.categories;
create trigger categories_trash_marks before update on public.categories
  for each row execute function public.trash_marks_are_rpc_only();

/* ---- 4. The allowlist -------------------------------------------------- */

/*
   The single place that decides what a bin may hold. Anything absent is
   refused by name, which is how "orders, order_items, payment_events,
   wallets, wallet_transactions and admin_audit_log cannot be trashed"
   becomes a property of the database rather than a promise in a comment.
*/
create or replace function public.trash_kind(p_kind text)
returns text language sql immutable as $$
  select case lower(btrim(coalesce(p_kind, '')))
           when 'menu_item' then 'menu_item'
           when 'category'  then 'category'
           else null
         end;
$$;

comment on function public.trash_kind is
  'Allowlist of trashable record kinds. Returns null for everything else, '
  'including every financial and accountability table.';

/* ---- 5. Put something in the bin --------------------------------------- */

create or replace function public.admin_trash_put(
  p_kind text, p_id text, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_kind  text := public.trash_kind(p_kind);
  v_label text;
  v_extra jsonb := '{}'::jsonb;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can move something to Trash' using errcode = '42501';
  end if;
  if v_kind is null then
    raise exception 'That kind of record cannot be moved to Trash: %', p_kind
      using errcode = '42501';
  end if;

  perform set_config('kt.trash_op', 'on', true);

  if v_kind = 'menu_item' then
    select name into v_label from public.menu_items
     where id = p_id::uuid and deleted_at is null;
    if v_label is null then
      raise exception 'No such menu item, or it is already in Trash' using errcode = 'P0002';
    end if;

    update public.menu_items
       set status_before_trash = status,
           status              = 'hidden',
           deleted_at          = now(),
           deleted_by          = auth.uid(),
           delete_reason       = nullif(btrim(coalesce(p_reason, '')), '')
     where id = p_id::uuid;

    /* Recorded so the Trash screen can warn before a purge. */
    select jsonb_build_object(
             'order_lines', (select count(*) from public.order_items where menu_item_id = p_id::uuid),
             'stock_moves', (select count(*) from public.inventory_movements where menu_item_id = p_id::uuid))
      into v_extra;

  else
    select name into v_label from public.categories
     where id = p_id and deleted_at is null;
    if v_label is null then
      raise exception 'No such category, or it is already in Trash' using errcode = 'P0002';
    end if;

    /* Same refusal the UI already makes, now enforced server-side: a
       category holding live dishes would orphan them on the way out. */
    if exists (select 1 from public.menu_items
                where category_id = p_id and deleted_at is null) then
      raise exception 'That category still holds live menu items. Move or trash them first.'
        using errcode = '23503';
    end if;

    update public.categories
       set deleted_at    = now(),
           deleted_by    = auth.uid(),
           delete_reason = nullif(btrim(coalesce(p_reason, '')), '')
     where id = p_id;
  end if;

  perform set_config('kt.trash_op', '', true);

  perform public.log_admin_action(
    'trash.put', case v_kind when 'menu_item' then 'menu_items' else 'categories' end,
    p_id, 'Moved "' || left(v_label, 80) || '" to Trash',
    jsonb_build_object('kind', v_kind, 'reason', nullif(btrim(coalesce(p_reason, '')), ''))
      || v_extra);

  return jsonb_build_object('status', 'ok', 'kind', v_kind, 'id', p_id, 'label', v_label);
end;
$$;

revoke all on function public.admin_trash_put(text, text, text) from public, anon;
grant execute on function public.admin_trash_put(text, text, text) to authenticated;

/* ---- 6. Take it back out ----------------------------------------------- */

create or replace function public.admin_trash_restore(p_kind text, p_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_kind  text := public.trash_kind(p_kind);
  v_label text;
  v_back  text;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can restore from Trash' using errcode = '42501';
  end if;
  if v_kind is null then
    raise exception 'That kind of record cannot be restored: %', p_kind using errcode = '42501';
  end if;

  perform set_config('kt.trash_op', 'on', true);

  if v_kind = 'menu_item' then
    select name, coalesce(status_before_trash, 'hidden')
      into v_label, v_back
      from public.menu_items where id = p_id::uuid and deleted_at is not null;
    if v_label is null then
      raise exception 'That menu item is not in Trash' using errcode = 'P0002';
    end if;

    /* A dish whose category was trashed meanwhile would come back orphaned.
       Restoring the category first is the owner's call, not a silent one. */
    if exists (select 1 from public.categories c
                join public.menu_items m on m.category_id = c.id
               where m.id = p_id::uuid and c.deleted_at is not null) then
      raise exception 'Restore the category first — this dish belongs to one that is in Trash'
        using errcode = '23503';
    end if;

    update public.menu_items
       set status              = v_back,
           status_before_trash = null,
           deleted_at          = null,
           deleted_by          = null,
           delete_reason       = null
     where id = p_id::uuid;
  else
    select name into v_label from public.categories
     where id = p_id and deleted_at is not null;
    if v_label is null then
      raise exception 'That category is not in Trash' using errcode = 'P0002';
    end if;

    update public.categories
       set deleted_at = null, deleted_by = null, delete_reason = null
     where id = p_id;
    v_back := 'active';
  end if;

  perform set_config('kt.trash_op', '', true);

  perform public.log_admin_action(
    'trash.restore', case v_kind when 'menu_item' then 'menu_items' else 'categories' end,
    p_id, 'Restored "' || left(v_label, 80) || '" from Trash',
    jsonb_build_object('kind', v_kind, 'restored_to', v_back));

  return jsonb_build_object('status', 'ok', 'kind', v_kind, 'id', p_id,
                            'label', v_label, 'restored_to', v_back);
end;
$$;

revoke all on function public.admin_trash_restore(text, text) from public, anon;
grant execute on function public.admin_trash_restore(text, text) to authenticated;

/* ---- 7. What is in the bin --------------------------------------------- */

/*
   Manager+ may look. Only the owner sees `can_act` true, so the screen's
   buttons are the server's answer rather than a guess the browser makes.
*/
create or replace function public.admin_trash_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_rows jsonb;
begin
  if not public.is_manager() then
    raise exception 'Trash is available to admins and the owner only' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(x order by x.deleted_at desc), '[]'::jsonb)
    into v_rows
    from (
      select 'menu_item' as kind, m.id::text as id, m.name as label,
             m.deleted_at, m.delete_reason,
             nullif(btrim(coalesce(p.display_name, '')), '') as deleted_by_name,
             p.role as deleted_by_role,
             jsonb_build_object(
               'status_before_trash', m.status_before_trash,
               'order_lines', (select count(*) from public.order_items oi where oi.menu_item_id = m.id),
               'stock_moves', (select count(*) from public.inventory_movements im where im.menu_item_id = m.id),
               'stock_counts', (select count(*) from public.inventory_counts ic where ic.menu_item_id = m.id)
             ) as detail
        from public.menu_items m
        left join public.profiles p on p.id = m.deleted_by
       where m.deleted_at is not null
      union all
      select 'category', c.id, c.name, c.deleted_at, c.delete_reason,
             nullif(btrim(coalesce(p.display_name, '')), ''), p.role,
             jsonb_build_object(
               'items', (select count(*) from public.menu_items m2 where m2.category_id = c.id))
        from public.categories c
        left join public.profiles p on p.id = c.deleted_by
       where c.deleted_at is not null
    ) x;

  return jsonb_build_object(
    'viewer_role', public.auth_role(),
    'can_act',     public.is_owner(),
    'rows',        v_rows);
end;
$$;

revoke all on function public.admin_trash_list() from public, anon;
grant execute on function public.admin_trash_list() to authenticated;

/* ---- 8. Permanent deletion -------------------------------------------- */

/*
   Separate, owner-only, and refused outright where history depends on the
   row — which is the common case for anything that was ever ordered. The
   brief asks that permanent deletion be possible for non-financial records;
   it also asks that historical order data stay intact. Both hold: a dish
   nobody ever ordered can be purged, one that was ordered cannot.
*/
create or replace function public.admin_trash_purge(p_kind text, p_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_kind  text := public.trash_kind(p_kind);
  v_label text;
  v_lines  integer;
  v_moves  integer;
  v_counts integer;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can permanently delete' using errcode = '42501';
  end if;
  if v_kind is null then
    raise exception 'That kind of record cannot be deleted: %', p_kind using errcode = '42501';
  end if;

  if v_kind = 'menu_item' then
    select name into v_label from public.menu_items
     where id = p_id::uuid and deleted_at is not null;
    if v_label is null then
      raise exception 'Purge only from Trash' using errcode = 'P0002';
    end if;

    select count(*) into v_lines from public.order_items where menu_item_id = p_id::uuid;
    select count(*) into v_moves from public.inventory_movements where menu_item_id = p_id::uuid;
    select count(*) into v_counts from public.inventory_counts where menu_item_id = p_id::uuid;

    /* The whole point of Phase 10. A dish that appears in a paid order stays
       in the database forever so that order keeps resolving. */
    if v_lines > 0 then
      raise exception
        'Cannot delete "%": it appears on % historical order line(s). It stays in Trash.',
        v_label, v_lines using errcode = '23503';
    end if;
    if v_moves > 0 then
      raise exception
        'Cannot delete "%": it has % inventory movement(s) on record.', v_label, v_moves
        using errcode = '23503';
    end if;
    /* inventory_counts.menu_item_id is ON DELETE RESTRICT too. The FK would
       have stopped this anyway — the data was never at risk — but it would
       have surfaced as a raw constraint dump. Checked here so the refusal
       says what it means. The count rows themselves are never touched. */
    if v_counts > 0 then
      raise exception
        'Cannot delete "%": it has inventory count history and cannot be permanently deleted.',
        v_label using errcode = '23503';
    end if;

    delete from public.menu_items where id = p_id::uuid;
  else
    select name into v_label from public.categories
     where id = p_id and deleted_at is not null;
    if v_label is null then
      raise exception 'Purge only from Trash' using errcode = 'P0002';
    end if;
    if exists (select 1 from public.menu_items where category_id = p_id) then
      raise exception 'Cannot delete "%": menu items still reference it.', v_label
        using errcode = '23503';
    end if;
    delete from public.categories where id = p_id;
  end if;

  perform public.log_admin_action(
    'trash.purge', case v_kind when 'menu_item' then 'menu_items' else 'categories' end,
    p_id, 'PERMANENTLY deleted "' || left(v_label, 80) || '"',
    jsonb_build_object('kind', v_kind, 'irreversible', true));

  return jsonb_build_object('status', 'ok', 'kind', v_kind, 'id', p_id, 'label', v_label);
end;
$$;

revoke all on function public.admin_trash_purge(text, text) from public, anon;
grant execute on function public.admin_trash_purge(text, text) to authenticated;

commit;

/* ---- 9. Live reporting must not count what is in the bin --------------- */

/*
   admin_dashboard() counted every menu row and listed everything that was
   not 'available', so a trashed dish would have shown up as "Hidden from the
   menu" on the operations feed. This is that function with two added
   conditions and nothing else changed — it was spliced from 0041
   programmatically rather than retyped, so the reporting logic is
   byte-identical apart from the two `deleted_at is null` lines.
*/

begin;

create or replace function public.admin_dashboard()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_role     text := public.auth_role();
  v_mgr      boolean := public.is_manager();
  v_sup      boolean := public.is_supervisor();
  v_today    timestamptz := public.kt_today_start();
  v_support  jsonb;
  v_finance  jsonb := null;
  v_orders   jsonb;
  v_menu     jsonb;
  v_recent   jsonb;
  v_activity jsonb;
  v_crit     integer := 0;
  v_warn     integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  /* ---- Orders. Counts only; no money is summed here. ------------------- */
  select jsonb_build_object(
           'today',          count(*) filter (where o.created_at >= v_today),
           'new',            count(*) filter (where o.status = 'New'),
           'preparing',      count(*) filter (where o.status = 'Preparing'),
           'out',            count(*) filter (where o.status = 'Out'),
           'completed_today', count(*) filter (where o.status = 'Completed'
                                                 and o.updated_at >= v_today),
           'cancelled_today', count(*) filter (where o.status = 'Cancelled'
                                                 and o.updated_at >= v_today),
           'unpaid_active',  count(*) filter (where not o.paid
                                                and o.status not in ('Completed', 'Cancelled')))
    into v_orders
    from public.orders o;

  /* ---- Support. The existing RPC, verbatim. ---------------------------- */
  v_support := public.admin_support_unread();

  /* ---- Menu availability ----------------------------------------------- */
  select jsonb_build_object(
           'total',     count(*),
           'sold_out',  count(*) filter (where status = 'sold_out'),
           'hidden',    count(*) filter (where status = 'hidden'))
    into v_menu
    from public.menu_items
   where deleted_at is null;

  /* ---- Finance. Manager+ only, and absent — not null — otherwise. ------
     admin_reconciliation() re-checks is_manager() itself, so this branch is
     belt and braces rather than the control. */
  if v_mgr then
    select count(*) filter (where r.severity = 'critical'),
           count(*) filter (where r.severity = 'warning')
      into v_crit, v_warn
      from public.admin_reconciliation(200) r;

    v_finance := jsonb_build_object('critical', v_crit, 'warning', v_warn);
  end if;

  /* ---- Recent orders ---------------------------------------------------
     `customer` is the snapshot taken at checkout. Only the NAME is read from
     it: phone and email live in the same jsonb and are not the dashboard's
     business at any tier. */
  select coalesce(jsonb_agg(jsonb_build_object(
           'code', s.code, 'status', s.status, 'total', s.total,
           'paid', s.paid, 'fulfilment', s.fulfilment,
           'customer', nullif(btrim(coalesce(s.customer ->> 'name', '')), ''),
           'at', s.created_at) order by s.created_at desc), '[]'::jsonb)
    into v_recent
    from (select o.code, o.status, o.total, o.paid, o.fulfilment,
                 o.customer, o.created_at
            from public.orders o
           order by o.created_at desc
           limit 6) s;

  /* ---- Recent activity -------------------------------------------------
     Built from OPERATIONAL tables, deliberately not from admin_audit_log.
     The audit log is owner-readable (0019) and records what colleagues did;
     dashboards are read by everyone with a login, and quietly widening who
     can see "X refunded an order" is not a UI decision to make. Every source
     below is something the caller's own tier can already open. */
  with ev as (
    select 'order.created' as kind, o.created_at as at,
           'New order' as title,
           o.code as subject,
           nullif(btrim(coalesce(o.customer ->> 'name', '')), '') as who,
           o.status as meta
      from public.orders o
     order by o.created_at desc limit 8
  ),
  st as (
    select 'order.status', h.created_at, 'Order ' || h.status,
           o.code, null::text, h.status
      from public.order_status_history h
      join public.orders o on o.id = h.order_id
     order by h.created_at desc limit 8
  ),
  ch as (
    select 'chat.message', m.created_at, 'Customer sent a message',
           c.id::text, nullif(btrim(coalesce(p.display_name, '')), ''), left(m.body, 90)
      from public.chat_messages m
      join public.chat_conversations c on c.id = m.conversation_id
      left join public.profiles p on p.id = c.user_id
     where m.sender_role = 'customer'
     order by m.created_at desc limit 8
  ),
  tk as (
    select 'ticket.created', t.created_at, 'Support ticket raised',
           t.id::text, nullif(btrim(coalesce(p.display_name, '')), ''), left(t.subject, 90)
      from public.support_tickets t
      left join public.profiles p on p.id = t.user_id
     order by t.created_at desc limit 6
  ),
  tr as (
    select 'ticket.reply', r.created_at, 'Customer replied to a ticket',
           r.ticket_id::text, null::text, left(r.body, 90)
      from public.support_ticket_replies r
     where r.author_role = 'customer'
     order by r.created_at desc limit 6
  ),
  cm as (
    /* Supervisor+ only: contact_messages carry a phone number and moved to
       is_supervisor() in 0037. A staff caller gets an empty branch, not a
       redacted row. */
    select 'contact.received', c.created_at, 'Contact message received',
           c.id::text, nullif(btrim(c.name), ''), left(c.message, 90)
      from public.contact_messages c
     where v_sup
     order by c.created_at desc limit 6
  ),
  mi as (
    select 'menu.unavailable', m.updated_at,
           case when m.status = 'sold_out' then 'Marked sold out' else 'Hidden from the menu' end,
           m.id::text, m.name, m.status
      from public.menu_items m
     where m.status <> 'available'
       and m.deleted_at is null
     order by m.updated_at desc limit 6
  ),
  merged as (
    select * from ev union all select * from st union all select * from ch
    union all select * from tk union all select * from tr
    union all select * from cm union all select * from mi
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', kind, 'at', at, 'title', title,
           'subject', subject, 'who', who, 'meta', meta) order by at desc), '[]'::jsonb)
    into v_activity
    from (select * from merged order by at desc limit 14) x;

  return jsonb_build_object(
    'generated_at', now(),
    'today_start', v_today,
    'viewer_role', v_role,
    'is_manager', v_mgr,
    'is_supervisor', v_sup,
    'orders', v_orders,
    'support', v_support,
    'menu', v_menu,
    /* Absent for staff and supervisor rather than present-and-zero: a card
       that reads "0 payment issues" to someone who may not look at payments
       is still an answer about payments. */
    'finance', v_finance,
    'recent_orders', v_recent,
    'activity', v_activity);
end;
$$;
commit;

/* ======================================================================
   PART B — STAFF FLAGS
   ----------------------------------------------------------------------
   Management accountability notes about a handler: an attendance problem, a
   mishandled order, a cash discrepancy — and, deliberately, recognition too,
   so the record is not only a punishment log.

   WHO CAN SEE THEM, AND WHY IT IS NOT SUPERVISOR

   Manager+ (admin and owner), matching every other team surface. The team
   roster is already admin+ in the nav and admin_list_team() is is_manager();
   supervisors have no team-management access today, and the brief says a
   supervisor gets flag access only if existing permissions justify it. They
   do not, so supervisors are excluded. This adds no tier and shifts no
   boundary.

   THE SUBJECT DOES NOT SEE THEIR OWN FLAGS

   A staff member can read their own profiles row, and the obvious mistake
   would be to hang flags off it. These are private management records: there
   is no policy under which the subject can read them, and staff_flags is not
   reachable from any customer-facing function. If the business later wants
   to show someone a note, that is a deliberate feature with its own wording,
   not a side effect of profile access.

   HISTORY IS NOT DELETABLE

   No DELETE grant and no delete function. A flag that stops mattering is
   resolved or dismissed, and the row keeps saying who decided that and when.
   ====================================================================== */

begin;

create table if not exists public.staff_flags (
  id            uuid primary key default gen_random_uuid(),

  /* The subject must be a real profile. ON DELETE CASCADE because a deleted
     account has no accountability record to keep — and admin_can_delete_customer
     refuses to delete staff accounts anyway, so this is a formality. */
  staff_user_id uuid not null references public.profiles (id) on delete cascade,
  created_by    uuid references public.profiles (id) on delete set null,

  /* Open list rather than a lookup table: with a two-person kitchen a
     categories table would be ceremony. The CHECK keeps them honest. */
  category      text not null default 'other'
                  check (category in ('attendance', 'order_handling', 'customer_complaint',
                                      'cash', 'operational', 'policy', 'performance',
                                      'recognition', 'other')),
  severity      text not null default 'note'
                  check (severity in ('note', 'low', 'medium', 'high', 'critical')),
  status        text not null default 'open'
                  check (status in ('open', 'acknowledged', 'resolved', 'dismissed')),

  title         text not null check (btrim(title) <> ''),
  details       text not null default '',

  resolved_by   uuid references public.profiles (id) on delete set null,
  resolved_at   timestamptz,
  resolution    text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists staff_flags_subject_idx on public.staff_flags (staff_user_id, created_at desc);
create index if not exists staff_flags_open_idx    on public.staff_flags (status, severity)
  where status in ('open', 'acknowledged');

drop trigger if exists staff_flags_set_updated_at on public.staff_flags;
create trigger staff_flags_set_updated_at
  before update on public.staff_flags
  for each row execute function public.set_updated_at();

comment on table public.staff_flags is
  'Private management accountability notes about a staff member. Manager+ only. '
  'The subject cannot read their own flags. Never deleted — resolved or dismissed.';

/* ---- Access ------------------------------------------------------------
   SELECT only, manager+ only. Writes go through the SECURITY DEFINER
   functions below, so "a supervisor cannot raise a flag" and "nobody can
   delete history" hold at the grant level rather than in the interface.
*/
alter table public.staff_flags enable row level security;
revoke all on public.staff_flags from anon, authenticated;
grant select on public.staff_flags to authenticated;

create policy staff_flags_read on public.staff_flags
  for select to authenticated
  using ((select public.is_manager()));

/* ---- Who may manage a flag about whom ---------------------------------- */

/*
   ONE rule, asked by every write path, and always about the subject of the
   row being changed rather than about a parameter the caller chose.

   The first version of this migration checked the hierarchy against
   p_staff_user_id and then updated the row named by p_id. Those are not the
   same record. An admin could pass an ordinary staff member as
   p_staff_user_id — clearing the check — while editing a flag whose real
   subject was the owner, and the audit entry would then name the innocent
   staff member as the subject. The authorization and the audit both lied
   because both trusted an argument instead of the row.

   Everything now derives the subject from the stored row, so there is no
   argument left to disagree with it.
*/
create or replace function public.staff_flag_may_manage(p_subject uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_role text;
begin
  if not public.is_manager() then
    return false;
  end if;

  select role into v_role from public.profiles where id = p_subject;
  if v_role is null then
    return false;
  end if;

  /* Flags are operational records about handlers. A customer is a different
     feature with different privacy rules. */
  if public.role_rank(v_role) < public.role_rank('staff') then
    return false;
  end if;

  /* The owner may manage a flag about anyone, including admins and
     themselves. An admin may only manage flags about the tiers they already
     manage — staff and supervisors — so a note about the owner or a peer
     admin is out of reach. This is the same boundary admin_set_role() draws. */
  if not public.is_owner() and public.role_rank(v_role) >= public.role_rank('admin') then
    return false;
  end if;

  return true;
end;
$$;

revoke all on function public.staff_flag_may_manage(uuid) from public, anon;
grant execute on function public.staff_flag_may_manage(uuid) to authenticated;

/* ---- Raising one ------------------------------------------------------- */

create or replace function public.staff_flag_save(
  p_staff_user_id uuid,
  p_title         text,
  p_details       text default '',
  p_category      text default 'other',
  p_severity      text default 'note',
  p_id            uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id      uuid;
  v_subject uuid;          /* the subject actually authorised against */
  v_name    text;
  v_editing boolean := p_id is not null;
begin
  if not public.is_manager() then
    raise exception 'Staff flags are available to admins and the owner only'
      using errcode = '42501';
  end if;
  if btrim(coalesce(p_title, '')) = '' then
    raise exception 'A flag needs a summary' using errcode = '22023';
  end if;

  if v_editing then
    /*
       THE SUBJECT COMES FROM THE STORED ROW, NEVER FROM THE ARGUMENT.

       This is the whole fix: authorising against p_staff_user_id while
       updating the row named by p_id let an admin clear the check with an
       innocent id and then rewrite a flag about the owner.
    */
    select staff_user_id into v_subject from public.staff_flags where id = p_id;
    if v_subject is null then
      raise exception 'No such flag' using errcode = 'P0002';
    end if;

    /* A flag never changes who it is about. Reassigning one would turn an
       edit into a fabrication, and it is refused loudly rather than being
       quietly ignored so a mistaken caller learns something. */
    if p_staff_user_id is not null and p_staff_user_id <> v_subject then
      raise exception 'A flag cannot be reassigned to a different team member'
        using errcode = '42501';
    end if;
  else
    v_subject := p_staff_user_id;
    if v_subject is null then
      raise exception 'A flag needs a team member' using errcode = '22023';
    end if;
  end if;

  /* One rule, asked about the real subject on both paths. */
  if not public.staff_flag_may_manage(v_subject) then
    raise exception
      'You cannot raise or edit a flag about that person'
      using errcode = '42501';
  end if;

  select nullif(btrim(coalesce(display_name, '')), '')
    into v_name from public.profiles where id = v_subject;

  if v_editing then
    update public.staff_flags
       set title    = btrim(p_title),
           details  = coalesce(p_details, ''),
           category = p_category,
           severity = p_severity
     where id = p_id
    returning id into v_id;
  else
    insert into public.staff_flags
      (staff_user_id, created_by, title, details, category, severity)
    values
      (v_subject, auth.uid(), btrim(p_title), coalesce(p_details, ''),
       p_category, p_severity)
    returning id into v_id;
  end if;

  /* Audited against the real subject too, so the log cannot disagree with
     the row it describes. */
  perform public.log_admin_action(
    case when v_editing then 'staff_flag.update' else 'staff_flag.create' end,
    'staff_flags', v_id::text,
    (case when v_editing then 'Edited' else 'Raised' end) ||
      ' a ' || p_severity || ' flag for ' || coalesce(v_name, 'a team member') ||
      ': "' || left(btrim(p_title), 80) || '"',
    jsonb_build_object('category', p_category, 'severity', p_severity,
                       'subject', v_subject));

  /*
     Serious flags reach the other managers through the notification pipeline
     that already exists — one row per recipient, same bell, same push. The
     TITLE ONLY: the details are the sensitive half and stay in the screen.
     The subject is never notified; these are private management records.
  */
  if not v_editing and p_severity in ('high', 'critical') then
    perform public.notify_roles(
      array['admin', 'owner'],
      'admin_flag',
      case p_severity when 'critical' then 'Critical staff flag' else 'Staff flag raised' end,
      left(btrim(p_title), 140),
      v_id::text,
      auth.uid());
  end if;

  return jsonb_build_object('status', 'ok', 'id', v_id, 'subject', v_subject);
end;
$$;

revoke all on function public.staff_flag_save(uuid, text, text, text, text, uuid) from public, anon;
grant execute on function public.staff_flag_save(uuid, text, text, text, text, uuid) to authenticated;

/* ---- Working one through ----------------------------------------------- */

create or replace function public.staff_flag_set_status(
  p_id uuid, p_status text, p_resolution text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_title   text;
  v_was     text;
  v_subject uuid;
begin
  if not public.is_manager() then
    raise exception 'Staff flags are available to admins and the owner only'
      using errcode = '42501';
  end if;
  if p_status not in ('open', 'acknowledged', 'resolved', 'dismissed') then
    raise exception 'Unknown status: %', p_status using errcode = '22023';
  end if;

  select title, status, staff_user_id
    into v_title, v_was, v_subject
    from public.staff_flags where id = p_id;
  if v_title is null then
    raise exception 'No such flag' using errcode = 'P0002';
  end if;

  /*
     The same subject rule the edit path uses. Dismissing a flag is not a
     smaller act than editing one — an admin who could dismiss a note about
     the owner could make it go away, which is the inversion this hierarchy
     exists to prevent. Both paths therefore ask the same question about the
     same row.
  */
  if not public.staff_flag_may_manage(v_subject) then
    raise exception 'You cannot change the status of a flag about that person'
      using errcode = '42501';
  end if;

  update public.staff_flags
     set status      = p_status,
         /* Stamped only on the way into a closed state, and cleared if it is
            reopened, so the record never claims it was settled twice. */
         resolved_by = case when p_status in ('resolved', 'dismissed') then auth.uid() end,
         resolved_at = case when p_status in ('resolved', 'dismissed') then now() end,
         resolution  = case when p_status in ('resolved', 'dismissed')
                            then nullif(btrim(coalesce(p_resolution, '')), '') end
   where id = p_id;

  perform public.log_admin_action(
    'staff_flag.' || p_status, 'staff_flags', p_id::text,
    'Marked flag "' || left(v_title, 80) || '" as ' || p_status,
    jsonb_build_object('from', v_was, 'to', p_status, 'subject', v_subject,
                       'resolution', nullif(btrim(coalesce(p_resolution, '')), '')));

  return jsonb_build_object('status', 'ok', 'id', p_id, 'from', v_was, 'to', p_status);
end;
$$;

revoke all on function public.staff_flag_set_status(uuid, text, text) from public, anon;
grant execute on function public.staff_flag_set_status(uuid, text, text) to authenticated;

/* ---- Reading ----------------------------------------------------------- */

create or replace function public.staff_flags_list(
  p_staff_user_id uuid default null, p_include_closed boolean default true
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_rows jsonb;
begin
  if not public.is_manager() then
    raise exception 'Staff flags are available to admins and the owner only'
      using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(x order by
           case x.status when 'open' then 0 when 'acknowledged' then 1 else 2 end,
           case x.severity when 'critical' then 0 when 'high' then 1
                           when 'medium' then 2 when 'low' then 3 else 4 end,
           x.created_at desc), '[]'::jsonb)
    into v_rows
    from (
      select f.id, f.staff_user_id, f.category, f.severity, f.status,
             f.title, f.details, f.created_at, f.resolved_at, f.resolution,
             nullif(btrim(coalesce(s.display_name, '')), '') as staff_name,
             s.role as staff_role,
             nullif(btrim(coalesce(a.display_name, '')), '') as created_by_name,
             nullif(btrim(coalesce(r.display_name, '')), '') as resolved_by_name
        from public.staff_flags f
        join public.profiles s on s.id = f.staff_user_id
        left join public.profiles a on a.id = f.created_by
        left join public.profiles r on r.id = f.resolved_by
       where (p_staff_user_id is null or f.staff_user_id = p_staff_user_id)
         and (p_include_closed or f.status in ('open', 'acknowledged'))
    ) x;

  return jsonb_build_object(
    'viewer_role', public.auth_role(),
    'can_manage',  true,
    'is_owner',    public.is_owner(),
    'rows',        v_rows);
end;
$$;

revoke all on function public.staff_flags_list(uuid, boolean) from public, anon;
grant execute on function public.staff_flags_list(uuid, boolean) to authenticated;

/*
   The per-person counters the Team page paints beside each member. Kept
   separate from staff_flags_list so the roster does not have to pull every
   flag body just to show a badge.
*/
create or replace function public.staff_flag_summary()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_rows jsonb;
begin
  if not public.is_manager() then
    raise exception 'Staff flags are available to admins and the owner only'
      using errcode = '42501';
  end if;

  select coalesce(jsonb_object_agg(t.staff_user_id, t.counts), '{}'::jsonb)
    into v_rows
    from (
      select f.staff_user_id::text as staff_user_id,
             jsonb_build_object(
               'open',     count(*) filter (where f.status in ('open', 'acknowledged')),
               'severe',   count(*) filter (where f.status in ('open', 'acknowledged')
                                              and f.severity in ('high', 'critical')),
               'resolved', count(*) filter (where f.status in ('resolved', 'dismissed')),
               'last_at',  max(f.created_at)) as counts
        from public.staff_flags f
       group by f.staff_user_id
    ) t;

  return v_rows;
end;
$$;

revoke all on function public.staff_flag_summary() from public, anon;
grant execute on function public.staff_flag_summary() to authenticated;

/* ---- The bell learns the new type -------------------------------------- */

/*
   Same correction admin_ticket needed in Phase 14 and admin_announcement in
   Phase 05: a type absent from this list notifies nobody visibly. This is
   0057's function with 'admin_flag' added to both lists and nothing else
   changed.
*/
create or replace function public.admin_notifications(
  p_limit integer default 20, p_unread_only boolean default false
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_rows jsonb;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', n.id, 'type', n.type, 'title', n.title, 'message', n.message,
           'related_id', n.related_id, 'read', n.read, 'created_at', n.created_at)
         order by n.created_at desc), '[]'::jsonb)
    into v_rows
    from (select * from public.notifications
           where user_id = v_uid
             and type in ('admin_order', 'admin_support', 'admin_ticket',
                          'admin_announcement', 'admin_flag', 'payment', 'message')
             and (not p_unread_only or read = false)
           order by created_at desc
           limit greatest(1, least(coalesce(p_limit, 20), 50))) n;

  return jsonb_build_object(
    'rows', v_rows,
    'unread', (select count(*) from public.notifications
                where user_id = v_uid and read = false
                  and type in ('admin_order', 'admin_support', 'admin_ticket',
                               'admin_announcement', 'admin_flag', 'payment', 'message')),
    'unread_orders', (select count(*) from public.notifications
                       where user_id = v_uid and read = false and type = 'admin_order'),
    'viewer_role', public.auth_role());
end;
$$;

commit;
