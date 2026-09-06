/* ==========================================================================
   Kandy's Treats — Customer profile (Supabase)
   --------------------------------------------------------------------------
   public.profiles is owner-readable and owner-writable under RLS. Since
   migration 0009 the `authenticated` role holds column-level UPDATE on only
   display_name, phone, photo_url and updated_at, so a browser physically
   cannot write `role`, `id`, `created_at` or `legacy_firebase_uid` — the
   database rejects it before RLS or any trigger is consulted.

   The row always exists: handle_new_user() creates it in the same transaction
   as the auth account. The "create it if missing" dance the Firebase version
   needed is therefore gone.

   Favourites are on Supabase as of Phase 5A. They bridge to the catalogue,
   which is still served from Firestore, via menu_items.legacy_firestore_id —
   so the UI keeps handing us the ids it already knows.

   Notifications are Supabase as of Phase 11. This file keeps the two methods
   the account page already calls and forwards them to
   js/services/notifications.js, so there is one implementation rather than
   two that can disagree about what "read" means.
   ========================================================================== */

import { supabase, TABLES, errorMessage } from "./supabase.js";
import { authService } from "./auth.js";
import { notificationService } from "./notifications.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The UI still speaks Firestore menu ids. favourites.menu_item_id is a uuid
 * foreign key, so translate. Accepts a Supabase uuid unchanged, which makes
 * this forward-compatible with the catalogue migration.
 */
async function resolveMenuItemId(menuId) {
  const id = String(menuId || "");
  if (!id) return null;
  if (UUID_RE.test(id)) return id;

  const { data, error } = await supabase
    .from(TABLES.menuItems)
    .select("id")
    .eq("legacy_firestore_id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? data.id : null;
}

export const accountService = {
  /*
     The caller's own role and whether their staff workspace is closed.

     Deliberately an RPC rather than a column read: 0069 removed suspended_at
     from the client grant, and profiles_select_own is is_admin() (staff+), so
     granting the column back would have let every active staff member see who
     else was suspended. my_account_status() takes no argument, so there is no
     way to ask it about anybody but yourself.
  */
  async status() {
    const { data, error } = await supabase.rpc("my_account_status");
    if (error) throw error;
    return data || { role: "customer", suspended: false };
  },

  async profile() {
    const user = authService.user();
    if (!user) return null;

    const { data, error } = await supabase
      .from(TABLES.profiles)
      .select("id, display_name, phone, photo_url, role, created_at, legacy_firebase_uid")
      .eq("id", user.uid)
      .maybeSingle();

    if (error) throw error;
    const row = data || {};

    /* Same shape the Firebase implementation returned, so the account page,
       the side nav and the checkout customer snapshot all keep working. */
    return {
      uid: user.uid,
      displayName: row.display_name || user.displayName || "",
      email: user.email || "",
      phone: row.phone || "",
      photoURL: row.photo_url || user.photoURL || "",
      emailVerified: !!user.emailVerified,
      role: row.role || "customer",
      createdAt: row.created_at ? new Date(row.created_at) : null
    };
  },

  /** Only the columns the customer is granted. `role` is not one of them. */
  async updateProfile({ displayName, phone }) {
    const user = authService.user();
    if (!user) throw new Error("Please sign in first.");
    const KT = window.KT;

    const fields = {
      display_name: KT.rules.cleanString(displayName, 120),
      phone: KT.rules.normalizePhone(phone),
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from(TABLES.profiles)
      .update(fields)
      .eq("id", user.uid);
    if (error) throw error;

    /* Keep the auth metadata in step so user() reflects the new name without
       a reload — the account nav reads it before the profile row loads. */
    await supabase.auth.updateUser({
      data: { display_name: fields.display_name, phone: fields.phone }
    }).catch(() => { /* display-only; the profile row is authoritative */ });
  },

  /* ---- Favourites (Supabase) ----------------------------------------- */

  /**
   * Returns the menu ids the customer has favourited, in the id space the UI
   * is currently using. The catalogue is still Firestore-backed, so we hand
   * back legacy_firestore_id; once the menu moves to Supabase this same join
   * keeps working because the column is retained.
   */
  async favourites() {
    const uid = authService.uid();
    if (!uid) return [];

    const { data, error } = await supabase
      .from(TABLES.favourites)
      .select("menu_item_id, menu_items!inner(id, legacy_firestore_id)")
      .eq("user_id", uid);

    if (error) throw error;
    return (data || [])
      .map((r) => (r.menu_items && (r.menu_items.legacy_firestore_id || r.menu_items.id)))
      .filter(Boolean);
  },

  /** @returns {Promise<boolean>} true when the dish is now a favourite. */
  async toggleFavourite(menuId) {
    const uid = authService.uid();
    if (!uid) throw new Error("Please sign in to save favourites.");

    const itemId = await resolveMenuItemId(menuId);
    if (!itemId) throw new Error("That dish is no longer on the menu.");

    const { data: existing, error: findError } = await supabase
      .from(TABLES.favourites)
      .select("menu_item_id")
      .eq("user_id", uid)
      .eq("menu_item_id", itemId)
      .maybeSingle();
    if (findError) throw findError;

    if (existing) {
      const { error } = await supabase
        .from(TABLES.favourites)
        .delete()
        .eq("user_id", uid)
        .eq("menu_item_id", itemId);
      if (error) throw error;
      return false;
    }

    const { error } = await supabase
      .from(TABLES.favourites)
      .insert({ user_id: uid, menu_item_id: itemId });
    if (error) throw error;
    return true;
  },

  /* ---- Notifications (Phase 11) --------------------------------------- */

  /* Thin pass-throughs. The account page and the header bell must agree on
     what a notification is, so they share one module. */
  notifications(opts) { return notificationService.list(opts); },
  markNotificationRead(id) { return notificationService.markRead(id); },
  markAllNotificationsRead() { return notificationService.markAllRead(); },
  notificationHref(n) { return notificationService.href(n); }
};

export { errorMessage };
