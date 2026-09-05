/* ==========================================================================
   Kandy's Treats — Trash data access
   --------------------------------------------------------------------------
   Four RPCs and no table writes. Everything that moves a record in or out of
   the bin goes through a SECURITY DEFINER function that checks is_owner()
   and writes the audit log, so there is no path from this file to an
   unaudited deletion — including for public.categories, whose whole-table
   UPDATE grant would otherwise have allowed a silent PATCH.

   What may be trashed is decided by trash_kind() in the database, not here.
   A kind this file has never heard of is refused by Postgres, which is why
   "an order cannot be trashed" does not depend on the browser behaving.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";

/** How each kind is described in the interface. Presentation only. */
export const TRASH_KINDS = {
  menu_item: { label: "Menu item", icon: "flame",    table: "menu_items" },
  category:  { label: "Category",  icon: "settings", table: "categories" }
};

export const adminTrashService = {
  TRASH_KINDS,

  meta(kind) {
    return TRASH_KINDS[kind] || { label: kind || "Record", icon: "settings", table: "" };
  },

  /** Manager+ may look; only the owner gets can_act true. */
  async list() {
    const { data, error } = await supabase.rpc("admin_trash_list");
    if (error) throw error;
    return data || { rows: [], viewer_role: "", can_act: false };
  },

  async put(kind, id, reason) {
    const { data, error } = await supabase.rpc("admin_trash_put", {
      p_kind: kind, p_id: String(id), p_reason: reason || null
    });
    if (error) throw error;
    return data;
  },

  async restore(kind, id) {
    const { data, error } = await supabase.rpc("admin_trash_restore", {
      p_kind: kind, p_id: String(id)
    });
    if (error) throw error;
    return data;
  },

  /**
   * Irreversible. The database refuses this for anything a historical order
   * or an inventory movement still points at, so the confirmation in the UI
   * is a courtesy on top of a real constraint rather than the only guard.
   */
  async purge(kind, id) {
    const { data, error } = await supabase.rpc("admin_trash_purge", {
      p_kind: kind, p_id: String(id)
    });
    if (error) throw error;
    return data;
  }
};

export { errorMessage };
