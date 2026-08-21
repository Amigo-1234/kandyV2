/* ==========================================================================
   Kandy's Treats — Admin unread signal
   --------------------------------------------------------------------------
   The counter behind the red dot on the Support nav item.

   NO NEW TALLY. chat_conversations.admin_unread already exists, is maintained
   by chat_message_stamp() and is protected by guard_conversation_unread() —
   staff cannot raise it and customers cannot touch it at all. This module
   reads that column (plus the open-ticket count) through one RPC and adds
   nothing of its own, so there is no second number that could disagree with
   the one the Support Center shows.

   ITS OWN CHANNEL
   ---------------
   js/services/chat.js keeps a single module-level channel that the Support
   Center's inbox takes over while it is open. If the shell shared it, opening
   Support would silently cancel the badge for the rest of the session. This
   channel is named separately and lives as long as the admin shell does.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";

let channel = null;

export const adminNotifyService = {
  /** Refused server-side for anyone below staff. */
  async unread() {
    const { data, error } = await supabase.rpc("admin_support_unread");
    if (error) throw error;
    return data || {
      chat_messages: 0, chat_conversations: 0, open_tickets: 0, new_contacts: 0
    };
  },

  /**
   * Fires whenever anything the badge counts could have moved. The callback
   * re-reads the RPC rather than trying to add up payloads — realtime is the
   * hint, the database is the number.
   */
  subscribe(onChange) {
    adminNotifyService.unsubscribe();
    channel = supabase
      .channel("admin:unread")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" }, onChange)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "chat_conversations" }, onChange)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "support_tickets" }, onChange)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "support_tickets" }, onChange)
      .subscribe();
    return adminNotifyService.unsubscribe;
  },

  unsubscribe() {
    if (!channel) return;
    supabase.removeChannel(channel);
    channel = null;
  },

  /** Send one customer a deliberate message. Manager+, audited server-side. */
  async notifyCustomer(userId, title, message) {
    const { data, error } = await supabase.rpc("admin_notify_customer", {
      p_user_id: userId, p_title: title, p_message: message
    });
    if (error) throw error;
    return data;
  }
};

export { errorMessage };
