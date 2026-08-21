/* ==========================================================================
   Phase 12 — take sender_role out of the INSERT grant
   --------------------------------------------------------------------------
   Found by testing, not by reading: a customer POSTing
   {sender_role: "owner"} to chat_messages was ACCEPTED with 201, and the row
   landed with sender_role = 'customer'.

   So the outcome was always safe — chat_message_stamp() overwrites the column
   from auth_role() on BEFORE INSERT, and it is the reason nothing was ever
   actually forgeable. But the comment in js/services/chat.js says

     "sender_role ... 0030 removed it from the column grant."

   and that half was not true. 0030 removed it from the UPDATE grant; INSERT
   still carried it. The protection was one deep where the code claimed two.

   Nothing legitimate sends the column: chatService.send() omits it precisely
   so the trigger can derive it, and the admin inbox uses that same function.
   Revoking it costs nothing and restores the layer the comment describes —
   a forged role is now refused by the grant before any trigger runs, and the
   trigger remains as the backstop for any path that bypasses PostgREST.

   Tightening only. No policy is widened and no existing caller changes:
   chatService.send() sends conversation_id, sender_id and body, all of which
   remain granted.

   support_ticket_replies needs nothing — 0032 already granted author_role's
   table neighbours column by column (author_id, body, ticket_id) and left
   author_role out, which is the shape this migration gives chat_messages.
   ========================================================================== */

begin;

/*
   A column-level REVOKE does nothing against a TABLE-level grant, and
   `authenticated` holds plain `INSERT` on chat_messages — which covers every
   column including this one. The first attempt at this migration revoked the
   column and changed nothing at all; the forged insert still returned 201.

   So the table-wide grant comes off and the columns go back on individually,
   the same shape orders and profiles already use. sender_role is simply not
   in the list.
*/
revoke insert on public.chat_messages from authenticated;
grant insert (id, conversation_id, sender_id, body, read_at, created_at)
  on public.chat_messages to authenticated;

commit;
