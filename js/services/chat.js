/* ==========================================================================
   Kandy's Treats — Live chat
   --------------------------------------------------------------------------
   One conversation per customer, reached through the same Supabase client,
   session and realtime channel as everything else.

   Two things are deliberately NOT the browser's decision:

     sender_role   chat_message_stamp() overwrites it with auth_role() on
                   every insert, and 0030 removed it from the column grant.
                   A forged role is discarded before the row lands.

     who sees what RLS scopes conversations to `user_id = auth.uid() OR
                   is_admin()`. A customer asking for another customer's
                   thread gets zero rows, not an error — there is nothing to
                   hide behind a 403.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";
import { authService } from "./auth.js";

const CONVERSATIONS = "chat_conversations";
const MESSAGES = "chat_messages";

/** Live channel, kept module-level so leaving a page can always close it. */
let channel = null;

function shapeMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderRole: row.sender_role,
    mine: row.sender_id === authService.uid(),
    fromStaff: row.sender_role !== "customer",
    body: row.body,
    readAt: row.read_at ? new Date(row.read_at) : null,
    createdAt: row.created_at ? new Date(row.created_at) : null
  };
}

export const chatService = {
  /**
   * The signed-in customer's conversation, created on first use.
   * Not an RPC: the insert is already constrained to user_id = auth.uid().
   */
  async myConversation() {
    const uid = authService.uid();
    if (!uid) throw new Error("Please sign in to chat with us.");

    const { data: existing, error: readErr } = await supabase
      .from(CONVERSATIONS)
      .select("id, status, last_message_at, customer_unread, admin_unread, created_at")
      .eq("user_id", uid)
      .maybeSingle();
    if (readErr) throw readErr;
    if (existing) return existing;

    const { data: created, error: insErr } = await supabase
      .from(CONVERSATIONS)
      .insert({ user_id: uid })
      .select("id, status, last_message_at, customer_unread, admin_unread, created_at")
      .single();
    if (insErr) throw insErr;
    return created;
  },

  async messages(conversationId, { limit = 200 } = {}) {
    const { data, error } = await supabase
      .from(MESSAGES)
      .select("id, conversation_id, sender_id, sender_role, body, read_at, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw error;
    return (data || []).map(shapeMessage);
  },

  /** sender_role is intentionally absent — the trigger sets it. */
  async send(conversationId, body) {
    const uid = authService.uid();
    if (!uid) throw new Error("Please sign in to chat with us.");

    const text = window.KT.rules.cleanString(body, 2000);
    if (!text) throw new Error("Type a message first.");

    const { data, error } = await supabase
      .from(MESSAGES)
      .insert({ conversation_id: conversationId, sender_id: uid, body: text })
      .select("id, conversation_id, sender_id, sender_role, body, read_at, created_at")
      .single();
    if (error) throw error;
    return shapeMessage(data);
  },

  /** Clear MY badge only; 0030 refuses any attempt to touch the other side's. */
  async markRead(conversationId, side = "customer") {
    const patch = side === "customer" ? { customer_unread: 0 } : { admin_unread: 0 };
    const { error } = await supabase
      .from(CONVERSATIONS).update(patch).eq("id", conversationId);
    if (error) throw error;
  },

  /**
   * Realtime, reusing the shared client's socket. Returns an unsubscribe so a
   * page can never leave a channel behind — repeated opens would otherwise
   * stack duplicate handlers and double-render every message.
   */
  subscribe(conversationId, onMessage) {
    chatService.unsubscribe();
    channel = supabase
      .channel("chat:" + conversationId)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: MESSAGES,
          filter: "conversation_id=eq." + conversationId },
        (payload) => onMessage(shapeMessage(payload.new)))
      .subscribe();
    return chatService.unsubscribe;
  },

  unsubscribe() {
    if (!channel) return;
    supabase.removeChannel(channel);
    channel = null;
  },

  /* ---- Admin side ------------------------------------------------------ */

  /** Every conversation, newest activity first. RLS admits admin tiers only. */
  async allConversations({ limit = 100 } = {}) {
    const { data, error } = await supabase
      .from(CONVERSATIONS)
      .select("id, user_id, status, last_message_at, customer_unread, admin_unread, created_at")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },

  /** Watch every conversation for new traffic (admin inbox). */
  subscribeAll(onMessage) {
    chatService.unsubscribe();
    channel = supabase
      .channel("chat:inbox")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: MESSAGES },
        (payload) => onMessage(shapeMessage(payload.new)))
      .subscribe();
    return chatService.unsubscribe;
  }
};

export { errorMessage };
