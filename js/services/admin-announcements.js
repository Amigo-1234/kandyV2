/* ==========================================================================
   Kandy's Treats — Staff announcements
   --------------------------------------------------------------------------
   Internal notices for handlers. NOT public.announcements, which is the
   customer-facing promo strip on the storefront and is readable by anyone —
   see js/services/content.js. The two are separate tables for exactly that
   reason and must not be confused.

   Publishing notifies through the existing notifications pipeline, from
   inside staff_announcement_save(); nothing here sends anything.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";

export const PRIORITIES = [
  { id: "normal",    label: "Normal" },
  { id: "important", label: "Important" },
  { id: "urgent",    label: "Urgent" }
];

export const adminAnnouncementsService = {
  PRIORITIES,

  /** What the caller may see. RLS decides; managers also get drafts. */
  async list(includeArchived) {
    const { data, error } = await supabase.rpc("staff_announcements_list",
      { p_include_archived: !!includeArchived });
    if (error) throw error;
    return data;
  },

  /**
   * Create or update. Manager+ — the server checks, not this.
   * Publishing is what notifies, and only on the transition into published.
   */
  async save(fields) {
    const f = fields || {};
    const { data, error } = await supabase.rpc("staff_announcement_save", {
      p_id: f.id || null,
      p_title: f.title || "",
      p_body: f.body || "",
      p_priority: f.priority || "normal",
      p_publish: !!f.publish,
      p_expires_at: f.expiresAt || null
    });
    if (error) throw error;
    return data;
  },

  /** Archive, or put back. Never deletes — a live notice is part of the day. */
  async archive(id, restore) {
    const { data, error } = await supabase.rpc("staff_announcement_archive",
      { p_id: id, p_restore: !!restore });
    if (error) throw error;
    return data;
  }
};

export { errorMessage };
