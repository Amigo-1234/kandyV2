/* ==========================================================================
   Kandy's Treats — App settings data access
   --------------------------------------------------------------------------
   Six keys, all of which already existed in public.app_settings. Nothing here
   invents a setting, and nothing here duplicates data that lives elsewhere —
   the menu, coupons and announcements have their own modules.

   READ  admin_settings() — one RPC, manager+, which returns each row together
         with the tier that owns it and whether THIS viewer may edit it. The
         form's disabled state is therefore the server's answer, not a guess
         this file makes from a role string.

   WRITE a plain PATCH on app_settings. That is deliberate rather than lazy:
         the column grant covers only (value, updated_at), the UPDATE policy
         requires is_manager(), and a BEFORE UPDATE trigger re-checks the
         per-key tier, validates the shape and stamps updated_at. An RPC
         wrapper would add a fourth place for the rule to live and a fourth
         place for it to drift.

   The SHAPES below mirror the trigger's validation exactly. They exist to
   give the person a good error before the round trip, never to be the check
   that matters — the database refuses a bad value regardless.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";

const TABLE = "app_settings";

/**
 * How each key is presented and re-assembled. `fields` are what the form
 * shows; `pack` turns those inputs back into the jsonb the column holds.
 */
export const SETTING_FIELDS = {
  ordering_enabled: {
    kind: "toggle",
    blurb: "When this is off, customers cannot place a new order. Staff can still " +
           "create orders in the admin, so the kitchen keeps working.",
    pack: (v) => !!v.enabled,
    unpack: (value) => ({ enabled: value === true })
  },
  eta_minutes: {
    kind: "fields",
    blurb: "The times quoted to customers at checkout.",
    fields: [
      { name: "pickup", label: "Pickup", suffix: "min", min: 1, max: 240 },
      { name: "delivery", label: "Delivery", suffix: "min", min: 1, max: 240 }
    ],
    pack: (v) => ({ pickup: Number(v.pickup), delivery: Number(v.delivery) }),
    unpack: (value) => ({ pickup: value.pickup, delivery: value.delivery })
  },
  delivery_fee: {
    kind: "fields",
    blurb: "Flat fee added to every delivery order. Read by the checkout " +
           "function on the server, so this figure is the one customers pay.",
    fields: [{ name: "amount", label: "Fee", prefix: "₦", min: 0, max: 100000 }],
    pack: (v) => Number(v.amount),
    unpack: (value) => ({ amount: value })
  },
  takeaway_fee: {
    kind: "fields",
    blurb: "Packaging charged per order, depending on what is in the basket.",
    fields: [
      { name: "standard", label: "Standard pack", prefix: "₦", min: 0, max: 100000 },
      { name: "combined", label: "Combined pack", prefix: "₦", min: 0, max: 100000 }
    ],
    pack: (v) => ({ standard: Number(v.standard), combined: Number(v.combined) }),
    unpack: (value) => ({ standard: value.standard, combined: value.combined })
  },
  processing_fee_rate: {
    kind: "fields",
    blurb: "Reserved for card processing. Stored as a rate — 0.02 is 2%.",
    fields: [{ name: "rate", label: "Rate", step: "0.001", min: 0, max: 0.2 }],
    pack: (v) => Number(v.rate),
    unpack: (value) => ({ rate: value })
  },
  service_area: {
    kind: "fields",
    blurb: "The coverage wording customers see. Changing it does not change " +
           "which addresses the kitchen will actually deliver to.",
    fields: [
      { name: "label", label: "Label", type: "text" },
      { name: "state", label: "State", type: "text" },
      { name: "country", label: "Country", type: "text" }
    ],
    pack: (v) => ({
      label: String(v.label || "").trim(),
      state: String(v.state || "").trim(),
      country: String(v.country || "").trim()
    }),
    unpack: (value) => ({
      label: value.label, state: value.state, country: value.country
    })
  }
};

export const adminSettingsService = {
  SETTING_FIELDS,

  meta(key) {
    return SETTING_FIELDS[key] || { kind: "raw", blurb: "", fields: [] };
  },

  async list() {
    const { data, error } = await supabase.rpc("admin_settings");
    if (error) throw error;
    return data || { rows: [], viewer_role: "", is_owner: false };
  },

  /**
   * `value` is the packed jsonb, not a form object. updated_at is not sent:
   * the trigger stamps it, so a client cannot backdate its own change.
   */
  async save(key, value) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({ value })
      .eq("key", key)
      .select("key, value, updated_at")
      .single();
    if (error) throw error;
    return data;
  }
};

export { errorMessage };
