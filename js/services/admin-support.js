/* ==========================================================================
   Kandy's Treats — Support Center data access
   --------------------------------------------------------------------------
   Tickets and contact messages. Live Chat is NOT re-implemented here — the
   Support Center calls the existing js/services/chat.js, which already owns
   the conversation queries, the realtime channel and the server-derived
   sender role.

   Existing status vocabularies are used verbatim:
     tickets   open | answered | closed
     contacts  new  | read     | answered
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";
import { authService } from "./auth.js";

const TICKETS = "support_tickets";
const REPLIES = "support_ticket_replies";
const CONTACTS = "contact_messages";

export const TICKET_STATUSES = ["open", "answered", "closed"];
export const CONTACT_STATUSES = ["new", "read", "answered"];

function shapeTicket(row, names) {
  return {
    id: row.id,
    ref: String(row.id).slice(0, 8).toUpperCase(),
    userId: row.user_id,
    customer: (names && names[row.user_id]) || "",
    subject: row.subject || "(no subject)",
    message: row.message || "",
    status: row.status || "open",
    orderRef: row.order_ref || null,
    createdAt: row.created_at ? new Date(row.created_at) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at) : null
  };
}

export const CHAT_FILTERS = [
  { id: "all",    label: "All" },
  { id: "unread", label: "Unread" },
  { id: "recent", label: "Recent" }
];

export const adminSupportService = {
  TICKET_STATUSES,
  CONTACT_STATUSES,
  CHAT_FILTERS,

  /**
   * The support inbox. One RPC does the conversation/profile/last-message
   * join, the search and the paging in Postgres.
   *
   * This replaces a client-side pattern that fetched every conversation and
   * then called admin_list_customers({limit: 200}) purely to turn user_ids
   * into names — an N+1 in disguise that also had no way to search or page.
   *
   * It is not a second chat system: reading a thread, sending and the
   * realtime channel all remain in js/services/chat.js. This only lists.
   * `email` comes back null for staff and supervisor, decided server-side.
   */
  async inbox({ search = "", filter = "all", limit = 30, offset = 0 } = {}) {
    const { data, error } = await supabase.rpc("admin_chat_inbox", {
      p_search: search, p_filter: filter, p_limit: limit, p_offset: offset
    });
    if (error) throw error;
    return data || { rows: [], total: 0, can_see_email: false, unread_total: 0 };
  },

  /**
   * Tickets, newest activity first. RLS returns only the caller's own rows
   * for a customer and everything for an admin tier, so this one query is
   * correct for both without a role branch here.
   */
  async tickets({ status = "all", search = "", limit = 100 } = {}) {
    let q = supabase
      .from(TICKETS)
      .select("id, user_id, subject, message, status, order_ref, created_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (status !== "all") q = q.eq("status", status);

    const term = String(search || "").trim();
    if (term) {
      /* Server-side filter: the browser never downloads the full table to
         search it. */
      q = q.or(`subject.ilike.%${term}%,message.ilike.%${term}%,order_ref.ilike.%${term}%`);
    }

    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map((r) => shapeTicket(r));
  },

  async ticket(id) {
    const { data, error } = await supabase
      .from(TICKETS)
      .select("id, user_id, subject, message, status, order_ref, created_at, updated_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data ? shapeTicket(data) : null;
  },

  async replies(ticketId) {
    const { data, error } = await supabase
      .from(REPLIES)
      .select("id, ticket_id, author_id, author_role, body, created_at")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return (data || []).map((r) => ({
      id: r.id,
      authorRole: r.author_role,
      fromStaff: r.author_role !== "customer",
      body: r.body,
      createdAt: r.created_at ? new Date(r.created_at) : null
    }));
  },

  /** author_role is omitted on purpose — the trigger derives it. */
  async reply(ticketId, body) {
    const uid = authService.uid();
    if (!uid) throw new Error("Please sign in.");
    const text = window.KT.rules.cleanString(body, 4000);
    if (!text) throw new Error("Type a reply first.");

    const { data, error } = await supabase
      .from(REPLIES)
      .insert({ ticket_id: ticketId, author_id: uid, body: text })
      .select("id, author_role, body, created_at")
      .single();
    if (error) throw error;
    return data;
  },

  /**
   * Status change. Granted at column level (status, updated_at) and gated by
   * is_admin(), so a customer's attempt is refused by Postgres, not by this
   * function. The change is audited by a trigger.
   */
  async setTicketStatus(id, status) {
    if (TICKET_STATUSES.indexOf(status) === -1) {
      throw new Error("Unknown ticket status.");
    }
    const { data, error } = await supabase
      .from(TICKETS)
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("id, status")
      .single();
    if (error) throw error;
    return data;
  },

  /* ---- Contact messages ------------------------------------------------- */

  /**
   * Manager+ only, enforced by RLS. Staff receive zero rows rather than an
   * error, so the view shows an explanatory empty state instead of a failure.
   */
  async contacts({ status = "all", search = "", limit = 100 } = {}) {
    let q = supabase
      .from(CONTACTS)
      .select("id, name, phone, message, status, source, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (status !== "all") q = q.eq("status", status);
    const term = String(search || "").trim();
    if (term) q = q.or(`name.ilike.%${term}%,message.ilike.%${term}%,phone.ilike.%${term}%`);

    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      message: r.message,
      status: r.status || "new",
      source: r.source || "website",
      createdAt: r.created_at ? new Date(r.created_at) : null
    }));
  },

  /** Only `status` is grantable — 0032 removed the rest. */
  async setContactStatus(id, status) {
    if (CONTACT_STATUSES.indexOf(status) === -1) {
      throw new Error("Unknown contact status.");
    }
    const { data, error } = await supabase
      .from(CONTACTS).update({ status }).eq("id", id).select("id, status").single();
    if (error) throw error;
    return data;
  }
};

export { errorMessage };
