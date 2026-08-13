/* ==========================================================================
   Kandy's Treats — Announcements, contact and support
   --------------------------------------------------------------------------
   Three small V1 collections that had no home in V2 until now:

     announcements/{id}   { text, active, createdAt }  — admin-published,
                          public read. Drives the promo strip so the kitchen
                          can change it without a deploy.
     contactMessages/{id} public intake from anyone, signed in or not.
     supportTickets/{id}  owner-scoped, attached to an order when relevant.

   IMPORTANT — contactMessages field shape:
   V1's own `contact.js` writes `{name, phone, message, createdAt, replied}`,
   but `firestore.rules` requires EXACTLY
   `["name","phone","message","status","source","createdAt"]` with
   `status == "new"`. V1's contact form is therefore rejected by its own
   rules. This module writes the shape the rules actually accept.
   ========================================================================== */

import { db, fb, COLLECTIONS } from "./firebase.js";
import { authService } from "./auth.js";

export const contentService = {
  /**
   * Live announcements, newest first. Public read, so this works for guests.
   * @returns {Promise<Array<{id:string,text:string}>>}
   */
  async announcements() {
    try {
      const snap = await fb.getDocs(fb.query(
        fb.collection(db, COLLECTIONS.announcements),
        fb.orderBy("createdAt", "desc"),
        fb.limit(5)
      ));
      return snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((a) => a.active !== false && String(a.text || "").trim())
        .map((a) => ({ id: a.id, text: String(a.text).trim() }));
    } catch {
      /* Missing index or offline — the strip keeps its built-in copy. */
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
      source: "v2-storefront",
      createdAt: fb.serverTimestamp()
    };

    if (!payload.name) throw new Error("Tell us your name.");
    if (!KT.rules.isValidPhone(payload.phone)) {
      throw new Error("Enter a valid Nigerian phone number so we can reply.");
    }
    if (payload.message.length < 5) throw new Error("Add a little more detail.");

    await fb.addDoc(fb.collection(db, COLLECTIONS.contactMessages), payload);
    return true;
  },

  /** Signed-in support request, optionally about a specific order. */
  async openSupportTicket({ subject, message, orderId }) {
    const uid = authService.uid();
    if (!uid) throw new Error("Please sign in to contact support.");
    const KT = window.KT;

    const ref = await fb.addDoc(fb.collection(db, COLLECTIONS.supportTickets), {
      userId: uid,
      subject: KT.rules.cleanString(subject, 140) || "Support request",
      message: KT.rules.cleanString(message, 2000),
      orderId: KT.rules.cleanString(orderId || "", 60) || null,
      status: "open",
      createdAt: fb.serverTimestamp(),
      updatedAt: fb.serverTimestamp()
    });
    return { id: ref.id };
  },

  async supportTickets({ limit = 10 } = {}) {
    const uid = authService.uid();
    if (!uid) return [];
    try {
      const snap = await fb.getDocs(fb.query(
        fb.collection(db, COLLECTIONS.supportTickets),
        fb.where("userId", "==", uid),
        fb.orderBy("createdAt", "desc"),
        fb.limit(limit)
      ));
      return snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          subject: data.subject,
          message: data.message,
          status: data.status || "open",
          orderId: data.orderId || null,
          createdAt: data.createdAt && data.createdAt.toDate ? data.createdAt.toDate() : null
        };
      });
    } catch {
      return [];
    }
  }
};
