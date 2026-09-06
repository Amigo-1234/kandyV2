/* ==========================================================================
   Kandy's Treats — PUBLIC customer announcements
   --------------------------------------------------------------------------
   public.announcements — the promo ticker every visitor reads, signed out
   included. This is NOT public.staff_announcements, which is the internal
   noticeboard with its own table, its own RPCs and its own screen
   (js/services/admin-announcements.js). Two tables, two audiences, and
   nothing here ever writes the other one.

   NO RPC LAYER, ON PURPOSE
   ------------------------
   The staff board needs staff_announcement_save() because publishing there
   has a side effect — it notifies every handler through the notification
   pipeline. Publishing here has no side effect at all: a row appears in a
   ticker the next time a visitor loads a page. There is nothing for a
   SECURITY DEFINER function to do that a policy does not already do, and
   adding one would mean a second place where "who may publish" is decided.

   So these are plain PostgREST calls and the RLS policies are the whole of
   the authorization. As of migration 0073 those are:

     read    anon + authenticated, active and in-window rows
             (a manager additionally sees drafts and expired rows)
     write   is_manager() — admin and owner only

   A supervisor, a staff member or a customer calling save() below gets a
   refusal from Postgres, not from this file. The admin screen hides the
   controls from them as a courtesy; the database is what stops them.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";

const TABLE = "announcements";
const COLUMNS = "id, title, body, active, starts_at, ends_at, sort_order, created_at";

/** Trim and cap, so a stray paste cannot put 40kB into a 38px strip. */
function clean(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

/**
 * Is this row on the strip right now? Mirrors the read policy's window
 * clause and contentService's client-side filter, so the admin's "Live"
 * badge and what a visitor actually sees cannot disagree.
 */
function isLive(row, now) {
  const t = now || new Date().toISOString();
  if (!row.active) return false;
  if (row.starts_at && row.starts_at > t) return false;
  if (row.ends_at && row.ends_at < t) return false;
  return true;
}

export const publicAnnouncementsService = {
  isLive,

  /**
   * Everything the caller may see, newest-relevant first. A manager sees
   * drafts and expired rows too — that is the read policy's is_admin()
   * branch, not a filter this file removes.
   */
  async list() {
    const { data, error } = await supabase
      .from(TABLE)
      .select(COLUMNS)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    const now = new Date().toISOString();
    return (data || []).map((r) => ({
      id: r.id,
      title: r.title || "",
      body: r.body || "",
      active: !!r.active,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      sortOrder: Number(r.sort_order) || 0,
      createdAt: r.created_at,
      live: isLive(r, now)
    }));
  },

  /**
   * Create or update. Manager+ — enforced by the policy, not by this call.
   * `body` is the line the ticker shows; `title` is the internal handle the
   * strip falls back to when a body is empty.
   */
  async save(fields) {
    const f = fields || {};
    const row = {
      title: clean(f.title, 120),
      body: clean(f.body, 300),
      active: !!f.active,
      starts_at: f.startsAt || null,
      ends_at: f.endsAt || null,
      sort_order: Number.isFinite(Number(f.sortOrder)) ? Number(f.sortOrder) : 0
    };
    if (!row.body) throw new Error("An announcement needs a message.");

    const q = f.id
      ? supabase.from(TABLE).update(row).eq("id", f.id).select(COLUMNS)
      : supabase.from(TABLE).insert(row).select(COLUMNS);

    const { data, error } = await q;
    if (error) throw error;
    /* An UPDATE that matched no row comes back empty rather than failing —
       which is what a refused write looks like from the client side too. */
    if (!data || !data.length) {
      throw new Error("That announcement could not be saved. You may not have permission.");
    }
    return data[0];
  },

  /** The switch the strip actually reads. Separate from save() so toggling
      one row cannot accidentally rewrite its text. */
  async setActive(id, active) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({ active: !!active })
      .eq("id", id)
      .select("id, active");
    if (error) throw error;
    if (!data || !data.length) {
      throw new Error("That announcement could not be updated. You may not have permission.");
    }
    return data[0];
  },

  async remove(id) {
    const { error } = await supabase.from(TABLE).delete().eq("id", id);
    if (error) throw error;
  }
};

export { errorMessage };
