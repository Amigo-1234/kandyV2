/* ==========================================================================
   Phase 11D — the flagged person learns that something exists
   --------------------------------------------------------------------------
   staff_flag_save() notified admins and the owner, and only for high or
   critical flags. The subject was told nothing at all, which is why a real
   flag raised at severity 'note' reached nobody: not the managers (below the
   threshold) and not the person it was about (by design).

   The privacy rule is right and does not change here. What changes is that
   the subject now gets one generic line saying there is something to discuss.
   No category, no severity, no details, no author, related_id null.

   NOTHING ELSE MOVES. staff_flags keeps its single is_manager() SELECT
   policy, notifications keeps having no INSERT grant for anybody, and
   notify_user() stays ungranted to authenticated — which is exactly why this
   has to live inside this SECURITY DEFINER function and cannot be done from
   a browser.
   ========================================================================== */

begin;

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
     The subject is not told any of this — see the separate, deliberately
     contentless notice below.
  */
  /*
     AND THE SUBJECT LEARNS THAT SOMETHING EXISTS — nothing more.

     A private record nobody can mention is not accountability, it is a
     file. This tells the person there is something to discuss and sends
     them to their manager to discuss it. It carries no category, no
     severity, no details, no author, and related_id is null so the bell
     renders it as plain text with nowhere to click — href() has no case
     for this type and returns null, so there is no route from here into
     any management screen.

     Only on creation. Editing a flag does not re-notify, and resolving or
     dismissing one says nothing either: the conversation happens between
     people, not through this channel.

     notification_channels() has no case for 'staff_notice', so it falls to
     the default in_app + push. It is therefore never email-eligible, which
     matters: a generic line on a phone is fine, the same line sitting in an
     inbox forever is not.
  */
  if not v_editing then
    perform public.notify_user(
      v_subject,
      'staff_notice',
      'Attention item on your staff account',
      'There is an attention item on your staff account. Please speak with '
        || 'your supervisor or manager.',
      null,      /* related_id: deliberately nothing to open */
      false);    /* no collapse — it needs a related_id to collapse on */
  end if;

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

commit;
