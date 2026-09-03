/* ==========================================================================
   Kandy's Treats — Inventory data access
   --------------------------------------------------------------------------
   Four RPCs. No arithmetic happens here: the daily equation is defined once,
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

  /** The day's picture for every tracked product. `day` is YYYY-MM-DD or null. */
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

  /** Record a physical count. Supervisor+; the server checks, not this. */
  async count(menuItemId, qty, note) {
    const { data, error } = await supabase.rpc("inventory_count_record", {
      p_menu_item_id: menuItemId,
      p_qty: qty,
      p_note: note || ""
    });
    if (error) throw error;
    return data;
  }
};

export { errorMessage };
