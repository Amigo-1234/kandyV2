/* ==========================================================================
   Phase 12 — the operational dashboard, and a real support inbox
   --------------------------------------------------------------------------
   Two read-only RPCs. No new table, no new column, no new business rule, and
   nothing here writes anything.

   WHY RPCS RATHER THAN QUERIES IN THE BROWSER
   -------------------------------------------
   The dashboard needs eight or nine counts. Done from the client that is
   eight or nine round trips, each one a `head: true` count, and the *shape*
   of what a role may see would be decided by which requests the JavaScript
   chose to make. Phase 12 §3 is explicit that the UI must not be the
   authorisation boundary, so the tier decides here: a staff caller does not
   receive a finance block that the interface then hides — the key is absent
   from the response entirely.

   NOTHING IS RE-DERIVED
   ---------------------
   Both functions delegate to what already exists rather than restating it:

     admin_support_unread()   unread chats, open tickets, new contacts
     admin_reconciliation()   the payment-issue count, severity by severity

   That matters more than the round trips saved. admin_reconciliation() is
   ~60 lines of union'd mismatch definitions; a second copy here would be a
   second thing to keep true. The dashboard counts the rows it returns and
   nothing else, so the number on the card is the number on the Finance
   screen by construction.

   Both are gated on is_admin() — the "may reach the admin app" predicate,
   which since 0037 means staff, supervisor, admin or owner. Inside a SECURITY
   DEFINER function RLS no longer filters anything, so every tier-dependent
   field below is gated explicitly and deliberately.
   ========================================================================== */

begin;

/* ---- Local midnight ---------------------------------------------------- */

/*
   "Today" means today in the kitchen, not today in UTC. Kandy's serves
   Ado-Ekiti; at 00:30 West Africa Time a UTC-based count would still be
   showing yesterday's orders, which is exactly when a kitchen dashboard is
   least forgivable.
*/
create or replace function public.kt_today_start()
returns timestamptz language sql stable as $$
  select (date_trunc('day', (now() at time zone 'Africa/Lagos')) at time zone 'Africa/Lagos');
$$;

revoke all on function public.kt_today_start() from public;
grant execute on function public.kt_today_start() to authenticated;

/* ---- The dashboard ----------------------------------------------------- */

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
    from public.menu_items;

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

revoke all on function public.admin_dashboard() from public;
grant execute on function public.admin_dashboard() to authenticated;

/* ---- The support inbox ------------------------------------------------- */

/*
   The old inbox read every conversation, then called admin_list_customers()
   with limit 200 purely to turn user_ids into names, and did its filtering in
   the browser. This does the join once, in Postgres, with the search and the
   paging where they belong.

   It is NOT a second chat system: sending, reading a thread and the realtime
   channel all stay in js/services/chat.js against chat_messages. This only lists.
*/
create or replace function public.admin_chat_inbox(
  p_search text default '',
  p_filter text default 'all',
  p_limit  integer default 30,
  p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_mgr    boolean := public.is_manager();
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_filter text := coalesce(nullif(btrim(p_filter), ''), 'all');
  v_rows   jsonb;
  v_total  integer;
  v_recent timestamptz := now() - interval '7 days';
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  /* One pass. The total comes from a window function over the filtered set
     rather than a second identical CTE chain — two copies of this predicate
     would be two places for the search rule to drift. */
  with base as (
    select c.id, c.user_id, c.status, c.last_message_at, c.created_at,
           c.admin_unread, c.customer_unread,
           nullif(btrim(coalesce(p.display_name, '')), '') as name,
           u.email,
           (select m.body from public.chat_messages m
             where m.conversation_id = c.id
             order by m.created_at desc limit 1) as last_body,
           (select m.sender_role from public.chat_messages m
             where m.conversation_id = c.id
             order by m.created_at desc limit 1) as last_role
      from public.chat_conversations c
      left join public.profiles p on p.id = c.user_id
      left join auth.users u on u.id = c.user_id
  ),
  filtered as (
    select b.*, count(*) over () as total
      from base b
     where (v_filter = 'all'
            or (v_filter = 'unread' and b.admin_unread > 0)
            or (v_filter = 'recent' and b.last_message_at >= v_recent))
       and (v_search is null
            or b.name ilike '%' || v_search || '%'
            /* Searching by an address a staff member may not be shown would
               still confirm that the address exists. The search widens with
               the visibility, not ahead of it. */
            or (v_mgr and b.email ilike '%' || v_search || '%'))
  ),
  page as (
    select * from filtered
     order by last_message_at desc nulls last, created_at desc
     limit greatest(1, least(coalesce(p_limit, 30), 100))
    offset greatest(0, coalesce(p_offset, 0))
  )
  select coalesce(max(f.total), 0),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', f.id,
           'user_id', f.user_id,
           'name', f.name,
           /* Same redaction rule admin_list_customers() applies: an email is
              manager-and-above. Staff see a person, not an address. */
           'email', case when v_mgr then f.email else null end,
           'status', f.status,
           'last_message_at', f.last_message_at,
           'created_at', f.created_at,
           'admin_unread', f.admin_unread,
           'last_body', left(coalesce(f.last_body, ''), 120),
           'last_role', f.last_role)
           order by f.last_message_at desc nulls last, f.created_at desc), '[]'::jsonb)
    into v_total, v_rows
    from page f;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'viewer_role', public.auth_role(),
    'can_see_email', v_mgr,
    'unread_total', (select coalesce(sum(admin_unread), 0) from public.chat_conversations));
end;
$$;

revoke all on function public.admin_chat_inbox(text, text, integer, integer) from public;
grant execute on function public.admin_chat_inbox(text, text, integer, integer) to authenticated;

commit;
