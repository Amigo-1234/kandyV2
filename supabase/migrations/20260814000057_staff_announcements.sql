/* ==========================================================================
   Staff announcements — internal operational notices
   --------------------------------------------------------------------------
   WHY THIS IS NOT public.announcements

   That table already exists and is the CUSTOMER promo strip: policy
   announcements_read grants select to anon, and js/services/content.js feeds
   it into the navbar for signed-out visitors. Putting "the fryer is broken,
   push jollof today" into it would publish it on the storefront. Two
   audiences that must never mix get two tables.

   Deliberately simple: one notice, all staff. The brief warns against
   overbuilding audience targeting, and with a two-person kitchen a
   distribution list would be ceremony. Roles already exist if that changes.
   ========================================================================== */

begin;

create table if not exists public.staff_announcements (
  id        uuid primary key default gen_random_uuid(),
  title     text not null check (btrim(title) <> ''),
  body      text not null check (btrim(body) <> ''),

  /* How loudly to show it. Not a workflow — just how the list is ordered
     and coloured. */
  priority  text not null default 'normal'
              check (priority in ('normal', 'important', 'urgent')),

  /* draft   written, not yet visible to staff
     published visible to everyone from published_at
     archived  deliberately retired; kept, never deleted */
  status    text not null default 'draft'
              check (status in ('draft', 'published', 'archived')),

  author_id uuid references public.profiles (id) on delete set null,

  published_at timestamptz,
  /* Optional. A shift notice that stops mattering at closing time should
     stop shouting by itself. */
  expires_at   timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists staff_announcements_live_idx
  on public.staff_announcements (status, published_at desc);

create trigger staff_announcements_set_updated_at
  before update on public.staff_announcements
  for each row execute function public.set_updated_at();

comment on table public.staff_announcements is
  'Internal notices for handlers. NOT public.announcements, which is the '
  'customer-facing promo strip and is readable by anon.';

/* ---- Access -----------------------------------------------------------
   Handlers read what is published and unexpired. Managers additionally see
   drafts and archived notices, because they are the ones writing them.
   Customers are not in either case — is_admin() is staff and above.

   Writes go through the SECURITY DEFINER functions below; there is no
   INSERT, UPDATE or DELETE grant, so "staff cannot publish a management
   notice" holds at the grant level rather than in the UI.
*/
alter table public.staff_announcements enable row level security;
revoke all on public.staff_announcements from anon, authenticated;
grant select on public.staff_announcements to authenticated;

create policy staff_announcements_read on public.staff_announcements
  for select to authenticated
  using (
    (select public.is_manager())
    or (
      (select public.is_admin())
      and status = 'published'
      and (expires_at is null or expires_at > now())
    )
  );

/* ---- Writing ----------------------------------------------------------- */

/*
   Create or update one notice. Manager+ only — an operational instruction
   carries the authority of the person who can give it, so the tier that may
   write one is the tier that may already change settings and roles.

   Publishing is what notifies; saving a draft does not, so a half-written
   notice never reaches anybody's phone.
*/
create or replace function public.staff_announcement_save(
  p_id         uuid default null,
  p_title      text default '',
  p_body       text default '',
  p_priority   text default 'normal',
  p_publish    boolean default false,
  p_expires_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id      uuid;
  v_was     text;
  v_publish boolean := coalesce(p_publish, false);
begin
  if not public.is_manager() then
    raise exception 'Announcements are available to admins and the owner only'
      using errcode = '42501';
  end if;
  if btrim(coalesce(p_title, '')) = '' or btrim(coalesce(p_body, '')) = '' then
    raise exception 'An announcement needs a title and a message' using errcode = '22023';
  end if;
  if p_priority not in ('normal', 'important', 'urgent') then
    raise exception 'Unknown priority: %', p_priority using errcode = '22023';
  end if;

  if p_id is not null then
    select status into v_was from public.staff_announcements where id = p_id;
    if v_was is null then
      raise exception 'No such announcement' using errcode = 'P0002';
    end if;
  end if;

  if p_id is null then
    insert into public.staff_announcements
      (title, body, priority, status, author_id, published_at, expires_at)
    values
      (btrim(p_title), btrim(p_body), p_priority,
       case when v_publish then 'published' else 'draft' end,
       auth.uid(),
       case when v_publish then now() end,
       p_expires_at)
    returning id into v_id;
  else
    update public.staff_announcements
       set title  = btrim(p_title),
           body   = btrim(p_body),
           priority = p_priority,
           status = case when v_publish then 'published' else status end,
           /* Stamped once, on first publication — editing a live notice
              does not pretend it is new. */
           published_at = case
                            when v_publish and published_at is null then now()
                            else published_at
                          end,
           expires_at = p_expires_at
     where id = p_id
    returning id into v_id;
  end if;

  /*
     Publishing reaches handlers through the notification pipeline that
     already exists — one row per recipient, the same bell, the same push
     send. No second delivery mechanism. Only on the transition INTO
     published, so editing a live notice does not re-notify everyone.
  */
  if v_publish and coalesce(v_was, 'draft') <> 'published' then
    perform public.notify_roles(
      array['staff', 'supervisor', 'admin', 'owner'],
      'admin_announcement',
      case p_priority when 'urgent' then 'Urgent notice'
                      when 'important' then 'Important notice'
                      else 'New announcement' end,
      left(btrim(p_title), 140),
      v_id::text,
      auth.uid());          /* the author does not need telling */
  end if;

  perform public.log_admin_action(
    case when v_publish then 'announcement.publish' else 'announcement.save' end,
    'staff_announcements', v_id::text,
    (case when v_publish then 'Published' else 'Saved' end) ||
      ' announcement "' || left(btrim(p_title), 80) || '"',
    jsonb_build_object('priority', p_priority, 'published', v_publish));

  return jsonb_build_object('status', 'ok', 'id', v_id, 'published', v_publish);
end;
$$;

revoke all on function public.staff_announcement_save(uuid, text, text, text, boolean, timestamptz)
  from public, anon;
grant execute on function public.staff_announcement_save(uuid, text, text, text, boolean, timestamptz)
  to authenticated;

/*
   Archive rather than delete. A notice that was live is part of what
   happened that day, and the audit log points at rows that should still be
   there to look at.
*/
create or replace function public.staff_announcement_archive(p_id uuid, p_restore boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_title text; v_was text;
begin
  if not public.is_manager() then
    raise exception 'Announcements are available to admins and the owner only'
      using errcode = '42501';
  end if;

  select title, status into v_title, v_was from public.staff_announcements where id = p_id;
  if v_title is null then
    raise exception 'No such announcement' using errcode = 'P0002';
  end if;

  update public.staff_announcements
     set status = case when p_restore then 'published' else 'archived' end
   where id = p_id;

  perform public.log_admin_action(
    'announcement.' || case when p_restore then 'restore' else 'archive' end,
    'staff_announcements', p_id::text,
    (case when p_restore then 'Restored' else 'Archived' end) ||
      ' announcement "' || left(v_title, 80) || '"',
    jsonb_build_object('from', v_was,
                       'to', case when p_restore then 'published' else 'archived' end));

  return jsonb_build_object('status', 'ok', 'id', p_id);
end;
$$;

revoke all on function public.staff_announcement_archive(uuid, boolean) from public, anon;
grant execute on function public.staff_announcement_archive(uuid, boolean) to authenticated;

/* ---- Reading ----------------------------------------------------------- */

/*
   One call for the screen: the notices the caller may see, plus the author
   names, plus a count of what is live. The RLS policy above already decides
   WHICH rows; this exists so the list does not need a second round trip to
   turn author ids into names — and so a raw uuid never reaches the client.
*/
create or replace function public.staff_announcements_list(p_include_archived boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_mgr  boolean := public.is_manager();
  v_rows jsonb;
begin
  if not public.is_admin() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(x order by
           /* urgent first, then newest. Drafts sit above for the people who
              have to finish them. */
           case x.status when 'draft' then 0 else 1 end,
           case x.priority when 'urgent' then 0 when 'important' then 1 else 2 end,
           x.effective_at desc), '[]'::jsonb)
    into v_rows
    from (
      select a.id, a.title, a.body, a.priority, a.status,
             a.published_at, a.expires_at, a.created_at,
             coalesce(a.published_at, a.created_at) as effective_at,
             nullif(btrim(coalesce(p.display_name, '')), '') as author,
             p.role as author_role,
             (a.expires_at is not null and a.expires_at <= now()) as expired
        from public.staff_announcements a
        left join public.profiles p on p.id = a.author_id
       where v_mgr or (a.status = 'published'
                       and (a.expires_at is null or a.expires_at > now()))
         and (p_include_archived or a.status <> 'archived')
    ) x;

  return jsonb_build_object(
    'viewer_role', public.auth_role(),
    'can_manage',  v_mgr,
    'live', (select count(*) from public.staff_announcements
              where status = 'published'
                and (expires_at is null or expires_at > now())),
    'rows', v_rows);
end;
$$;

revoke all on function public.staff_announcements_list(boolean) from public, anon;
grant execute on function public.staff_announcements_list(boolean) to authenticated;

/* ---- The bell learns the new type -------------------------------------- */

/*
   admin_notifications() filters by type so the centre shows operational
   rows and not a customer's order updates. A new type has to be named here
   or a published announcement would notify nobody visibly — the same
   correction admin_ticket needed in Phase 14.
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
                          'admin_announcement', 'payment', 'message')
             and (not p_unread_only or read = false)
           order by created_at desc
           limit greatest(1, least(coalesce(p_limit, 20), 50))) n;

  return jsonb_build_object(
    'rows', v_rows,
    'unread', (select count(*) from public.notifications
                where user_id = v_uid and read = false
                  and type in ('admin_order', 'admin_support', 'admin_ticket',
                               'admin_announcement', 'payment', 'message')),
    'unread_orders', (select count(*) from public.notifications
                       where user_id = v_uid and read = false and type = 'admin_order'),
    'viewer_role', public.auth_role());
end;
$$;

commit;
