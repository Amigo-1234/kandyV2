/* ==========================================================================
   Kandy's Treats — Inventory data access
   --------------------------------------------------------------------------
   A handful of RPCs. No arithmetic happens here: the daily equation is defined once,
   in admin_inventory_day(), and this module only carries its answer to the
   screen. The end-of-day report calls the same function, so the two can never
   disagree.

   There is no update or delete call in this file because there is no update
   or delete grant on the ledger. A mistake is fixed by recording a correction
   that points at the movement it corrects — both stay visible afterwards.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";

/* Controlled vocabularies. Waste and adjustments must give a reason; the
   database enforces that a reason is present, and these are the words the
   UI offers so the history stays comparable across days. */
export const WASTE_REASONS = [
  { id: "burnt",          label: "Burnt" },
  { id: "spilled",        label: "Spilled" },
  { id: "spoiled",        label: "Spoiled" },
  { id: "dropped",        label: "Dropped" },
  { id: "overproduction", label: "Overproduction" },
  { id: "other",          label: "Other" }
];

export const ADJUSTMENT_REASONS = [
  { id: "opening_correction", label: "Opening correction" },
  { id: "count_correction",   label: "Counting correction" },
  { id: "damaged",            label: "Damaged stock found" },
  { id: "transfer",           label: "Transfer" },
  { id: "data_correction",    label: "Data correction" },
  { id: "other",              label: "Other" }
];

export const adminInventoryService = {
  WASTE_REASONS,
  ADJUSTMENT_REASONS,

  /** The day's picture for every menu product (0085). `day` is YYYY-MM-DD or null. */
  async day(day) {
    const { data, error } = await supabase.rpc("admin_inventory_day",
      { p_day: day || null });
    if (error) throw error;
    return data;
  },

  /** Movements and counts recorded on a day, newest first. */
  async history(day, menuItemId) {
    const { data, error } = await supabase.rpc("admin_inventory_history", {
      p_day: day || null,
      p_menu_item_id: menuItemId || null,
      p_limit: 100
    });
    if (error) throw error;
    return data;
  },

  /**
   * Record one movement.
   *
   * The server decides the business date, refuses an adjustment below
   * supervisor, and refuses a negative quantity on anything but an
   * adjustment — so none of those rules depend on this function being called
   * correctly.
   */
  async record(menuItemId, kind, qty, reason, note, correctsId) {
    const { data, error } = await supabase.rpc("inventory_record", {
      p_menu_item_id: menuItemId,
      p_kind: kind,
      p_qty: qty,
      p_reason: reason || null,
      p_note: note || "",
      p_corrects_id: correctsId || null
    });
    if (error) throw error;
    return data;
  },

  /**
   * Read-only history (0084): per day and per dish between two Lagos dates
   * (at most 62 days), with who recorded what, the notes, and which tracked
   * dishes had no entry or no count. A past day is only ever read here.
   */
  async range(from, to, menuItemId) {
    const { data, error } = await supabase.rpc("admin_inventory_range", {
      p_from: from || null, p_to: to || null, p_menu_item_id: menuItemId || null
    });
    if (error) throw error;
    return data;
  },

  /** Menu items that can be tracked, and whether this viewer may switch them. */
  async candidates() {
    const { data, error } = await supabase.rpc("admin_inventory_candidates");
    if (error) throw error;
    return data;
  },

  /** Admin/owner: track (or stop tracking) an EXISTING menu item. Never creates one. */
  async setTracking(menuItemId, tracked) {
    const { data, error } = await supabase.rpc("admin_set_stock_tracking", {
      p_menu_item_id: menuItemId, p_tracked: !!tracked
    });
    if (error) throw error;
    return data;
  },

  /**
   * Record a physical count — an opening count (before service) or a
   * closing count. Staff+ (0085); the server dates it and checks the tier.
   */
  async count(menuItemId, qty, note, opening) {
    const { data, error } = await supabase.rpc("inventory_count_record", {
      p_menu_item_id: menuItemId,
      p_qty: qty,
      p_note: note || "",
      p_opening: !!opening
    });
    if (error) throw error;
    return data;
  },

  /** The orders behind a product's "sold" figure on a day (read-only, 0085). */
  async sales(day, menuItemId) {
    const { data, error } = await supabase.rpc("admin_inventory_sales", {
      p_day: day || null, p_menu_item_id: menuItemId
    });
    if (error) throw error;
    return data;
  }
};

export { errorMessage };
