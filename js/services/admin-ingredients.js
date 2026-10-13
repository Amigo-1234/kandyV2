/* ==========================================================================
   Kandy's Treats — Ingredient stock data access (0084)
   --------------------------------------------------------------------------
   Raw ingredients and supplies, kept apart from finished-dish inventory: no
   call here reads or writes menu_items, and nothing in the database uses
   these figures to put a dish on or off sale.

   Like the dish ledger there is no update or delete call for entries — a
   mistake is corrected with an adjustment that points at it.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";

export const UNITS = [
  { id: "kg", label: "Kilograms (kg)" }, { id: "g", label: "Grams (g)" },
  { id: "litre", label: "Litres" }, { id: "ml", label: "Millilitres (ml)" },
  { id: "bag", label: "Bags" }, { id: "carton", label: "Cartons" },
  { id: "crate", label: "Crates" }, { id: "pack", label: "Packs" },
  { id: "piece", label: "Pieces" }, { id: "bottle", label: "Bottles" },
  { id: "tin", label: "Tins" }, { id: "sachet", label: "Sachets" },
  { id: "tuber", label: "Tubers" }, { id: "bunch", label: "Bunches" },
  { id: "basket", label: "Baskets" }, { id: "derica", label: "Derica" },
  { id: "mudu", label: "Mudu" }, { id: "bucket", label: "Buckets" },
  { id: "cup", label: "Cups" }, { id: "tray", label: "Trays" }, { id: "roll", label: "Rolls" }
];

export const CATEGORIES = [
  { id: "grains", label: "Grains & rice" }, { id: "proteins", label: "Meat, fish & eggs" },
  { id: "vegetables", label: "Vegetables & fruit" }, { id: "oils", label: "Oils" },
  { id: "spices", label: "Spices & seasoning" }, { id: "dairy", label: "Dairy" },
  { id: "drinks", label: "Drinks" }, { id: "packaging", label: "Packaging" },
  { id: "cleaning", label: "Cleaning" }, { id: "other", label: "Other" }
];

export const KINDS = [
  { id: "received",   label: "Received",   hint: "Delivered or bought in", sup: false },
  { id: "used",       label: "Used",       hint: "Taken for cooking", sup: false },
  { id: "waste",      label: "Waste",      hint: "Spoiled or thrown away — needs a reason", sup: false },
  { id: "adjustment", label: "Adjustment", hint: "Correcting the record (+ or −)", sup: true },
  { id: "count",      label: "Count",      hint: "What is actually in the store now", sup: true }
];

export const WASTE_REASONS = [
  { id: "spoiled", label: "Spoiled" }, { id: "expired", label: "Expired" },
  { id: "damaged", label: "Damaged" }, { id: "spilled", label: "Spilled" },
  { id: "pests", label: "Pests" }, { id: "other", label: "Other" }
];

export const ADJUSTMENT_REASONS = [
  { id: "count_correction", label: "Counting correction" },
  { id: "data_correction", label: "Data correction" },
  { id: "transfer", label: "Transfer" }, { id: "other", label: "Other" }
];

export const adminIngredientsService = {
  UNITS, CATEGORIES, KINDS, WASTE_REASONS, ADJUSTMENT_REASONS,

  /** The register as at the end of `day` (YYYY-MM-DD, null = today). */
  async list(day) {
    const { data, error } = await supabase.rpc("admin_ingredients", { p_day: day || null });
    if (error) throw error;
    return data;
  },

  /** Entries between two dates, newest first, with optional filters. */
  async history({ from, to, ingredientId, kind, search, limit = 300 } = {}) {
    const { data, error } = await supabase.rpc("admin_ingredient_history", {
      p_from: from || null, p_to: to || null, p_ingredient_id: ingredientId || null,
      p_kind: kind || null, p_search: search || null, p_limit: limit
    });
    if (error) throw error;
    return data;
  },

  /** Supervisor+: register (id null) or edit an ingredient. */
  async save(id, f) {
    const { data, error } = await supabase.rpc("ingredient_save", {
      p_id: id || null, p_name: f.name, p_unit: f.unit, p_category: f.category || "other",
      p_reorder_level: f.reorder === "" || f.reorder == null ? null : Number(f.reorder),
      p_notes: f.notes || "", p_active: f.active !== false
    });
    if (error) throw error;
    return data;
  },

  /** Record one entry. The server dates it and checks the role. */
  async record(id, kind, qty, reason, note, correctsId) {
    const { data, error } = await supabase.rpc("ingredient_record", {
      p_ingredient_id: id, p_kind: kind, p_qty: qty, p_reason: reason || null,
      p_note: note || "", p_corrects_id: correctsId || null
    });
    if (error) throw error;
    return data;
  }
};

export { errorMessage };
