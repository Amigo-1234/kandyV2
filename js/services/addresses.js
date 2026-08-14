/* ==========================================================================
   Kandy's Treats — Saved delivery addresses (Supabase)
   --------------------------------------------------------------------------
   Kandy's serves Lagos State only for this release, so there is no geocoding
   and no GPS: the customer types the address themselves and saves it for
   reuse, exactly as V1 does.

   The three Cloud Functions this used to call (saveCustomerAddress,
   deleteCustomerAddress, setDefaultCustomerAddress) are gone. Everything is a
   direct table operation now, which is safe because the database enforces what
   the callables used to:

     * RLS scopes every row to auth.uid(), so one customer can neither read nor
       write another's addresses.
     * The addresses_single_default trigger clears any other default for the
       same customer whenever a row is written with is_default = true.
     * A partial unique index (user_id) WHERE is_default is the hard guarantee
       behind that trigger — two defaults cannot exist even if the trigger were
       bypassed.

   Client-side cleaning and validation are unchanged, so the same input rules
   the customer already knows still apply.
   ========================================================================== */

import { supabase, TABLES, errorMessage } from "./supabase.js";
import { authService } from "./auth.js";

function clean(payload) {
  const KT = window.KT;
  return {
    label: KT.rules.cleanString(payload.label || "Delivery address", 60),
    recipientName: KT.rules.cleanString(payload.recipientName, 100),
    phone: KT.rules.normalizePhone(payload.phone),
    address: KT.rules.cleanString(payload.address, 500),
    notes: KT.rules.cleanString(payload.notes, 300),
    isDefault: Boolean(payload.isDefault)
  };
}

/** Postgres row -> the camelCase shape every page already reads. */
function toUI(row) {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    recipientName: row.recipient_name,
    phone: row.phone,
    address: row.address,
    notes: row.notes,
    isDefault: row.is_default,
    createdAt: row.created_at ? new Date(row.created_at) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at) : null
  };
}

function toRow(body, uid) {
  return {
    user_id: uid,
    label: body.label,
    recipient_name: body.recipientName,
    phone: body.phone,
    address: body.address,
    notes: body.notes,
    is_default: body.isDefault
  };
}

export const addressService = {
  async list() {
    const uid = authService.uid();
    if (!uid) return [];

    /* RLS already restricts this to the caller; the explicit filter states the
       intent and keeps the query index-friendly. */
    const { data, error } = await supabase
      .from(TABLES.addresses)
      .select("*")
      .eq("user_id", uid)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true });

    if (error) throw error;
    return (data || []).map(toUI);
  },

  /** @returns {Promise<{id:string}>} */
  async save(payload) {
    const uid = authService.uid();
    if (!uid) throw new Error("Please sign in to save an address.");

    const body = clean(payload);
    const check = window.KT.rules.validateAddress(body);
    if (!check.valid) {
      throw new Error(Object.values(check.errors)[0]);
    }

    /* Matches the old callable: a customer's very first address becomes their
       default automatically, so checkout always has one to preselect. */
    if (!payload.id && !body.isDefault) {
      const { count, error: countError } = await supabase
        .from(TABLES.addresses)
        .select("user_id", { count: "exact", head: true })
        .eq("user_id", uid);
      if (countError) throw countError;
      if (!count) body.isDefault = true;
    }

    if (payload.id) {
      const { data, error } = await supabase
        .from(TABLES.addresses)
        .update(toRow(body, uid))
        .eq("id", payload.id)
        .eq("user_id", uid)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("That address could not be found.");
      return { id: data.id };
    }

    const { data, error } = await supabase
      .from(TABLES.addresses)
      .insert(toRow(body, uid))
      .select("id")
      .single();
    if (error) throw error;
    return { id: data.id };
  },

  async remove(addressId) {
    const uid = authService.uid();
    if (!uid) throw new Error("Please sign in first.");

    const { error } = await supabase
      .from(TABLES.addresses)
      .delete()
      .eq("id", addressId)
      .eq("user_id", uid);
    if (error) throw error;
  },

  async makeDefault(addressId) {
    const uid = authService.uid();
    if (!uid) throw new Error("Please sign in first.");

    /* The trigger clears whichever address was default before this one. */
    const { error } = await supabase
      .from(TABLES.addresses)
      .update({ is_default: true })
      .eq("id", addressId)
      .eq("user_id", uid);
    if (error) throw error;
  }
};

export { errorMessage };
