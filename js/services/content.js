/* ==========================================================================
   Kandy's Treats — Announcements, contact and support (Supabase)
   --------------------------------------------------------------------------
     public.announcements    admin-published, public read. Drives the promo
                             strip so the kitchen can change it without a
                             deploy. The migration put V1's `text` into `body`.
     public.contact_messages public intake — `anon` holds INSERT, so this
                             works for a signed-out visitor exactly as before.
     public.support_tickets  owner-scoped under RLS, with order_ref carrying
                             the human order code for display.

   The Firestore contactMessages shape problem is gone with the collection:
   V1's own rules rejected V1's own contact form. Here the columns ARE the
   contract, and RLS pins status/source rather than a key whitelist.
   ========================================================================== */

import { supabase, TABLES, errorMessage } from "./supabase.js";
import { authService } from "./auth.js";

export const contentService = {
  /**
   * Live announcements, newest first. Public read, so this works for guests.
   * @returns {Promise<Array<{id:string,text:string}>>}
   */
  async announcements() {
    try {
      const nowISO = new Date().toISOString();
      const { data, error } = await supabase
        .from(TABLES.announcements)
        .select("id, title, body, active, starts_at, ends_at, sort_order, created_at")
        .eq("active", true)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: false })
        .limit(5);
      if (error) throw error;

      return (data || [])
        /* Honour a scheduling window when the kitchen sets one. */
        .filter((a) => (!a.starts_at || a.starts_at <= nowISO) &&
                       (!a.ends_at || a.ends_at >= nowISO))
        .map((a) => ({ id: a.id, text: String(a.body || a.title || "").trim() }))
        .filter((a) => a.text);
    } catch {
      /* Offline — the strip keeps its built-in copy. */
      return [];
    }
  },

  /** Public contact form. No account required, matching V1. */
  async sendContactMessage({ name, phone, message }) {
    const KT = window.KT;
    const payload = {
      name: KT.rules.cleanString(name, 100),
      phone: KT.rules.normalizePhone(phone),
      message: KT.rules.cleanString(message, 1000),
      status: "new",
      source: "v2-storefront"
    };

    if (!payload.name) throw new Error("Tell us your name.");
    if (!KT.rules.isValidPhone(payload.phone)) {
      throw new Error("Enter a valid Nigerian phone number so we can reply.");
    }
    if (payload.message.length < 5) throw new Error("Add a little more detail.");

    const { error } = await supabase.from(TABLES.contactMessages).insert(payload);
    if (error) throw error;
    return true;
  },

  /** Signed-in support request, optionally about a specific order. */
  async openSupportTicket({ subject, message, orderId }) {
    const uid = authService.uid();
    if (!uid) throw new Error("Please sign in to contact support.");
    const KT = window.KT;

    const { data, error } = await supabase
      .from(TABLES.supportTickets)
      .insert({
        user_id: uid,
        subject: KT.rules.cleanString(subject, 140) || "Support request",
        message: KT.rules.cleanString(message, 2000),
        order_ref: KT.rules.cleanString(orderId || "", 60) || null,
        status: "open"
      })
      .select("id")
      .single();

    if (error) throw error;
    return { id: data.id };
  },

  async supportTickets({ limit = 10 } = {}) {
    const uid = authService.uid();
    if (!uid) return [];
    try {
      const { data, error } = await supabase
        .from(TABLES.supportTickets)
        .select("id, subject, message, status, order_ref, created_at")
        .eq("user_id", uid)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;

      return (data || []).map((t) => ({
        id: t.id,
        subject: t.subject,
        message: t.message,
        status: t.status || "open",
        orderId: t.order_ref || null,
        createdAt: t.created_at ? new Date(t.created_at) : null
      }));
    } catch {
      return [];
    }
  }
};

export { errorMessage };
