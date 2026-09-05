/* ==========================================================================
   Kandy's Treats — Admin menu service
   --------------------------------------------------------------------------
   Loaded on demand by the admin app only. Imports the same supabase.js
   singleton as everything else — no second client.

   Nothing here is privileged by living in this file. An admin can create an
   item because `menu_items_admin_insert` says is_manager(); a staff member is
   held to availability by the enforce_menu_item_tier trigger; only an owner
   can delete because the delete policy says is_owner(). Calling these methods
   as the wrong role fails in Postgres, not here.
   ========================================================================== */

import { supabase, TABLES, errorMessage } from "./supabase.js";

const BUCKET = "menu-images";

const ITEM_COLUMNS =
  "id, name, blurb, description, price, category_id, section, status, " +
  "image_key, image_url, is_featured, sort_order, created_at, updated_at";

export const STATUSES = [
  { id: "available", label: "Available" },
  { id: "sold_out",  label: "Sold out" },
  { id: "hidden",    label: "Hidden" }
];

function toItem(r) {
  return {
    id: r.id,
    name: r.name,
    blurb: r.blurb || "",
    description: r.description || "",
    price: Number(r.price) || 0,
    categoryId: r.category_id || null,
    section: r.section || "",
    status: r.status,
    imageKey: r.image_key || "",
    imageUrl: r.image_url || "",
    isFeatured: r.is_featured === true,
    sortOrder: Number(r.sort_order) || 0,
    createdAt: r.created_at ? new Date(r.created_at) : null,
    updatedAt: r.updated_at ? new Date(r.updated_at) : null
  };
}

/** Client-side mirror of the DB constraints, so bad input never leaves here. */
export function validate(form) {
  const errors = {};
  const name = String(form.name || "").trim();
  const price = Number(form.price);

  if (!name) errors.name = "Give the item a name.";
  else if (name.length > 120) errors.name = "Keep the name under 120 characters.";

  if (form.price === "" || form.price === null || Number.isNaN(price)) {
    errors.price = "Enter a price.";
  } else if (!Number.isFinite(price) || price < 0) {
    errors.price = "Price cannot be negative.";
  } else if (!Number.isInteger(price)) {
    errors.price = "Price must be a whole number of naira.";
  }

  if (!form.categoryId) errors.categoryId = "Choose a category.";
  if (form.status && !STATUSES.some((s) => s.id === form.status)) {
    errors.status = "Unknown availability.";
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export const adminMenuService = {
  STATUSES,
  validate,

  async categories() {
    const { data, error } = await supabase
      .from("categories")
      .select("id, name, sort_order, active")
      .order("sort_order", { ascending: true });
    if (error) throw error;
    return data || [];
  },

  /** Server-backed list: filtering and search run in Postgres. */
  async list(opts) {
    opts = opts || {};
    /* Trashed dishes belong on the Trash screen, not in menu management.
       The RLS policy still returns them to staff+ — it has to, so Trash can
       list them — so the exclusion is made here, where the screen decides. */
    let q = supabase.from(TABLES.menuItems).select(ITEM_COLUMNS).is("deleted_at", null);

    if (opts.category && opts.category !== "all") q = q.eq("category_id", opts.category);
    if (opts.status && opts.status !== "all") q = q.eq("status", opts.status);

    const term = String(opts.search || "").trim();
    if (term) {
      const like = "*" + term.replace(/[*,()]/g, "") + "*";
      q = q.or(["name.ilike." + like, "blurb.ilike." + like, "description.ilike." + like].join(","));
    }

    const { data, error } = await q
      .order("category_id", { ascending: true })
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true })
      .limit(opts.limit || 300);
    if (error) throw error;
    return (data || []).map(toItem);
  },

  /**
   * Availability only — the single write a staff member is allowed. Sending
   * just `status` means this can never become a price edit by accident.
   */
  async setStatus(id, status) {
    const { data, error } = await supabase
      .from(TABLES.menuItems)
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("id, status");
    if (error) throw error;
    if (!data || !data.length) {
      throw new Error("That item could not be updated with your access level.");
    }
    return data[0];
  },

  /** Full edit — manager+ by policy; the trigger rejects a staff caller. */
  async save(id, form) {
    const check = validate(form);
    if (!check.valid) throw new Error(Object.values(check.errors)[0]);

    const payload = {
      name: String(form.name).trim(),
      blurb: String(form.blurb || "").trim(),
      description: String(form.description || "").trim(),
      price: Number(form.price),
      category_id: form.categoryId,
      status: form.status || "available",
      updated_at: new Date().toISOString()
    };
    if (form.imageUrl !== undefined) payload.image_url = form.imageUrl || null;

    const query = id
      ? supabase.from(TABLES.menuItems).update(payload).eq("id", id)
      : supabase.from(TABLES.menuItems).insert(
          Object.assign({ section: form.categoryId }, payload));

    const { data, error } = await query.select(ITEM_COLUMNS);
    if (error) throw error;
    if (!data || !data.length) {
      throw new Error("That change was refused by your access level.");
    }
    return toItem(data[0]);
  },

  /*
     Owner only, unchanged — but this no longer destroys the row.

     A hard DELETE here fired order_items.menu_item_id ON DELETE SET NULL,
     permanently severing every historical order line from the dish, and
     failed outright on inventory_movements' ON DELETE RESTRICT. It now goes
     to Trash: the row stays, history keeps resolving, and the owner can put
     it back. admin_trash_put() checks is_owner() and writes the audit log.
  */
  async remove(id, reason) {
    const { data, error } = await supabase.rpc("admin_trash_put", {
      p_kind: "menu_item", p_id: String(id), p_reason: reason || null
    });
    if (error) throw error;
    return data;
  },

  async removeCategory(id) {
    const { count, error: countError } = await supabase
      .from(TABLES.menuItems)
      .select("id", { count: "exact", head: true })
      .eq("category_id", id)
      .is("deleted_at", null);
    if (countError) throw countError;
    /* Refuse before the FK does, so the message is useful rather than a
       constraint dump — and so items are never orphaned. */
    if (count) {
      throw new Error("That category still holds " + count +
        " item(s). Move or delete them first.");
    }
    const { data, error } = await supabase.rpc("admin_trash_put", {
      p_kind: "category", p_id: String(id), p_reason: null
    });
    if (error) throw error;
    return data;
  },

  /** Upload a photo and return its public URL. manager+ by storage policy. */
  async uploadImage(file, itemId) {
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = (itemId || "new") + "-" + Date.now() + "." + ext;
    const { error } = await supabase.storage.from(BUCKET)
      .upload(path, file, { cacheControl: "3600", upsert: false });
    if (error) throw error;
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    return data.publicUrl;
  },

  /** Live catalogue updates over the existing Realtime channel. */
  watch(onChange, onStatus) {
    const channel = supabase
      .channel("admin-menu")
      .on("postgres_changes",
          { event: "*", schema: "public", table: "menu_items" },
          (payload) => onChange(payload))
      .subscribe((status) => { if (onStatus) onStatus(status); });
    return function unsubscribe() { supabase.removeChannel(channel); };
  }
};

export { errorMessage };
