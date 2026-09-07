/* ==========================================================================
   Phase 13 (addendum) — the flagged person can see that they are flagged
   --------------------------------------------------------------------------
   Phase 11D gave the subject of a staff flag a deliberately contentless
   notification, and 0072 finally made it visible in the admin notification
   centre. What it still could not do is answer the obvious next question:
   "is that still open?" A notice that appears once and then says nothing
   more leaves someone checking a bell for a thing that may already be
   resolved.

   This adds exactly one fact, about the caller and nobody else: whether an
   unresolved flag exists against their own account, and when the oldest one
   was raised.

   WHAT IT DELIBERATELY DOES NOT RETURN
   ------------------------------------
   No flag id. No title. No details. No category. No severity. No author. No
   resolution notes. No count — a count is itself a signal about how much
   management has recorded, and "three flags" invites a very different
   conversation from "a flag". The subject learns that there is something to
   discuss and is sent to a person to discuss it, which is the whole of the
   Phase 11D design; this only stops them having to guess whether it is still
   live.

   NO ARGUMENT, FOR THE SAME REASON my_account_status() HAS NONE
   ------------------------------------------------------------
   There is no p_user_id. A caller cannot ask about another account because
   there is nowhere to put the question. auth.uid() is the only subject this
   function will ever answer for, and that is a property of the signature
   rather than of a check that could be edited away later.

   staff_flags KEEPS ITS SINGLE is_manager() SELECT POLICY. Nothing here
   grants the subject read access to the table; this is SECURITY DEFINER and
   returns two scalars. Staff and supervisor still read zero rows from
   staff_flags itself, and there is no INSERT, UPDATE or DELETE path for them
   at all — so a flag cannot be edited, dismissed or resolved by its subject.
   ========================================================================== */

begin;

create or replace function public.my_staff_flag_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           /*
              'open' and 'acknowledged' are the two unresolved states in the
              existing lifecycle (open | acknowledged | resolved | dismissed).
              Reusing that column is what makes the staff-facing card clear
              itself the moment management resolves or dismisses the flag —
              there is no second status to keep in step.
           */
           'flagged', exists (select 1 from public.staff_flags f
                               where f.staff_user_id = auth.uid()
                                 and f.status in ('open', 'acknowledged')),
           /* The oldest unresolved one, so the card can say how long this has
              been waiting. A date is not a detail: the subject was there. */
           'since',   (select min(f.created_at) from public.staff_flags f
                        where f.staff_user_id = auth.uid()
                          and f.status in ('open', 'acknowledged'))
         );
$$;

comment on function public.my_staff_flag_status is
  'Whether the CALLER has an unresolved staff flag, and when the oldest was '
  'raised. Takes no argument, so it cannot be aimed at another account. '
  'Returns no id, title, detail, category, severity, author, count or '
  'resolution note — staff_flags keeps its single is_manager() SELECT policy '
  'and the subject still cannot read the table.';

revoke all on function public.my_staff_flag_status() from public, anon;
grant execute on function public.my_staff_flag_status() to authenticated;

commit;
