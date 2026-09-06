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

  /**
   * The handler's own notification centre. Reads only rows the database
   * addressed to THIS account (notifications_select_own scopes it to
   * user_id = auth.uid()), filtered to the operational types.
   *
   * AN UNREAD ROW MUST NEVER FALL OFF THE END
   * -----------------------------------------
   * The panel asks for the newest 20. On a busy account that window fills
   * with order alerts, and an older unread notice sits behind a badge that
   * counts it while the list it opens does not show it — a number telling
   * someone they have a message, and a panel that appears to disagree.
   *
   * Phase 12 hit this with a staff_notice, but nothing about it is specific
   * to that type and it is not fixed as if it were: any unread row missing
   * from the page is fetched and merged. `ensureUnread` is opt-in because
   * the badge refresh calls this with limit 1 and wants the count only —
   * it would otherwise pay for a second round trip on every poll.
   *
   * The second request only happens when the page genuinely does not
   * already hold every unread row, and it reuses the same RPC, the same
   * type allowlist and the same RLS scoping. No new endpoint, no second
   * notification store, no reordering: the merged list stays newest-first,
   * exactly as the RPC returns it.
   *
   * @param {{limit?:number, unreadOnly?:boolean, ensureUnread?:boolean}} opts
   */
  async centre({ limit = 20, unreadOnly = false, ensureUnread = false } = {}) {
    const { data, error } = await supabase.rpc("admin_notifications", {
      p_limit: limit, p_unread_only: unreadOnly
    });
    if (error) throw error;
    const page = data || { rows: [], unread: 0, unread_orders: 0 };
    if (!ensureUnread || unreadOnly) return page;

    const rows = page.rows || [];
    const shownUnread = rows.filter((r) => !r.read).length;
    /* Everything unread is already on the page — nothing to go and get. */
    if (shownUnread >= (page.unread || 0)) return page;

    const extra = await supabase.rpc("admin_notifications", {
      p_limit: 50, p_unread_only: true
    });
    /* A failure here costs the merge, not the panel: the first page is
       still a correct, if shorter, answer. */
    if (extra.error || !extra.data) return page;

    const seen = new Set(rows.map((r) => r.id));
    const missing = (extra.data.rows || []).filter((r) => !seen.has(r.id));
    if (!missing.length) return page;

    return Object.assign({}, page, {
      rows: rows.concat(missing).sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at)
      )
    });
  },

  /** Mark one. RLS allows only the caller's own rows, and only read/read_at. */
  async markRead(id) {
    const { error } = await supabase
      .from("notifications")
      .update({ read: true, read_at: new Date().toISOString() })
      .eq("id", id).eq("read", false);
    if (error) throw error;
  },

  /**
   * No user_id filter: RLS already scopes the statement to this account.
   *
   * The type list is deliberately the SAME one admin_notifications() reads
   * by, because this button says "mark all read" about the panel the user
   * is looking at. A type the centre shows but this misses stays unread for
   * ever; a type this covers but the centre never shows would silently
   * clear a customer's own notification from a screen that never displayed
   * it. Neither is acceptable, so the two lists move together.
   *
   * Customer-facing types — order, chat, support, wallet — are absent from
   * both, so a handler who also shops here keeps their own bell intact.
   */
  async markAllRead() {
    const { error } = await supabase
      .from("notifications")
      .update({ read: true, read_at: new Date().toISOString() })
      .eq("read", false)
      .in("type", ["admin_order", "admin_support", "admin_ticket",
                   "admin_announcement", "admin_flag", "staff_notice",
                   "payment", "message"]);
    if (error) throw error;
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
