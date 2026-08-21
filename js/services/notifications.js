/* ==========================================================================
   Kandy's Treats — Customer notifications
   --------------------------------------------------------------------------
   Reading and marking read. NOTHING here creates a notification, and nothing
   here could: `authenticated` has no INSERT grant on public.notifications at
   all, so every row arrives from a SECURITY DEFINER trigger on the server
   (migration 0040). A frontend-invented notification is not a bug we guard
   against — it is a statement Postgres refuses to execute.

   Marking read is a plain PATCH because it is already safe from both sides:
   the column grant covers only `read` and `read_at`, and the UPDATE policy is
   `user_id = auth.uid()` in USING and WITH CHECK. Another customer's row is
   not visible to the statement, so "mark all read" is scoped by the database
   rather than by the filter this file happens to send.

   THE CHANNEL IS ITS OWN
   ----------------------
   js/services/chat.js keeps a single module-level channel and swaps it
   between the customer thread and the admin inbox. Sharing that would mean
   opening Live Chat silently cancelled the bell. This module owns a separate
   channel, named per user, and hands back an unsubscribe so a page can never
   leave one behind.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";
import { authService } from "./auth.js";

const TABLE = "notifications";

/** One live channel at a time, module-level so signing out can always close it. */
let channel = null;
let channelUid = null;

function shape(row) {
  return {
    id: row.id,
    type: row.type || "message",
    title: row.title || "Update",
    message: row.message || "",
    relatedId: row.related_id || null,
    read: !!row.read,
    readAt: row.read_at ? new Date(row.read_at) : null,
    createdAt: row.created_at ? new Date(row.created_at) : null
  };
}

/**
 * Where a notification points. The type decides, not the presence of an id —
 * a chat notification carries a conversation id, and sending that to the
 * order-detail page would produce a dead link.
 */
function href(n) {
  const url = window.KT.url;
  switch (n.type) {
    case "order":
      return n.relatedId
        ? url("pages/order-detail.html?id=" + encodeURIComponent(n.relatedId))
        : url("pages/orders.html");
    case "chat":
      return url("pages/account.html?chat=1");
    case "support":
      return url("pages/account.html#support");
    case "wallet":
      return url("pages/account.html#wallet");
    default:
      return null;
  }
}

export const notificationService = {
  href,

  async list({ limit = 20 } = {}) {
    if (!authService.uid()) return [];
    const { data, error } = await supabase
      .from(TABLE)
      .select("id, type, title, message, related_id, read, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data || []).map(shape);
  },

  /** Count only — used by the bell so a badge costs no rows. */
  async unreadCount() {
    if (!authService.uid()) return 0;
    const { count, error } = await supabase
      .from(TABLE)
      .select("id", { count: "exact", head: true })
      .eq("read", false);
    if (error) throw error;
    return count || 0;
  },

  async markRead(id) {
    if (!id) return;
    const { error } = await supabase
      .from(TABLE)
      .update({ read: true, read_at: new Date().toISOString() })
      .eq("id", id)
      .eq("read", false);
    if (error) throw error;
  },

  /**
   * No user_id filter is sent on purpose. RLS already restricts the statement
   * to this customer's rows, and adding a client-side id would imply the
   * filter is what makes it safe.
   */
  async markAllRead() {
    if (!authService.uid()) return;
    const { error } = await supabase
      .from(TABLE)
      .update({ read: true, read_at: new Date().toISOString() })
      .eq("read", false);
    if (error) throw error;
  },

  /**
   * Live updates for the signed-in customer. Subscribes to INSERT *and*
   * UPDATE: migration 0040 collapses repeat replies in one conversation into
   * a single unread row, so a second message arrives as an update, not an
   * insert.
   */
  subscribe(onChange) {
    const uid = authService.uid();
    if (!uid) return () => {};
    if (channel && channelUid === uid) return notificationService.unsubscribe;

    notificationService.unsubscribe();
    channelUid = uid;
    channel = supabase
      .channel("notif:" + uid)
      .on("postgres_changes",
        { event: "*", schema: "public", table: TABLE, filter: "user_id=eq." + uid },
        (payload) => {
          const row = payload.new || payload.old;
          if (!row) return;
          onChange({ event: payload.eventType, notification: shape(row) });
        })
      .subscribe();
    return notificationService.unsubscribe;
  },

  unsubscribe() {
    if (!channel) return;
    supabase.removeChannel(channel);
    channel = null;
    channelUid = null;
  }
};

export { errorMessage };
