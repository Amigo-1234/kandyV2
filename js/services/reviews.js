/* ==========================================================================
   Kandy's Treats — Reviews (Supabase)
   --------------------------------------------------------------------------
   One review per customer per dish: public.reviews carries a UNIQUE
   (user_id, menu_item_id), so a second rating UPDATES the first rather than
   stacking. That replaces V1's deterministic `reviews/{uid}_{menuId}` id with
   a real database constraint.

   RLS makes reviews publicly readable but owner-writable, which is what lets
   the menu show an average to guests while stopping anyone editing someone
   else's rating.

   Customers can only review a dish they have actually been delivered: the
   rating UI lives on a Completed order, never on the product page cold.

   Note the return shape keeps a `name` field for contract compatibility. No
   page renders the review list — only `average` and `count` are displayed —
   so no reviewer name is denormalised into the table.
   ========================================================================== */

import { supabase, TABLES, errorMessage } from "./supabase.js";
import { authService } from "./auth.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts a Supabase uuid or a legacy Firestore menu id. */
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

/** The UI carries the human order code; reviews.order_id is a uuid FK. */
async function resolveOrderId(orderRef, uid) {
  const ref = String(orderRef || "");
  if (!ref) return null;

  const { data } = await supabase
    .from(TABLES.orders)
    .select("id, paid, status")
    .or(`code.eq.${ref},id.eq.${UUID_RE.test(ref) ? ref : "00000000-0000-0000-0000-000000000000"}`)
    .eq("user_id", uid)
    .maybeSingle();
  /* Mirror the RLS predicate so the check fails early with a clear message. */
  if (!data || !data.paid || data.status !== "Completed") return null;
  return data.id;
}

export const reviewService = {
  /** Public: every review for one dish, plus its average. */
  async forItem(menuId) {
    try {
      const itemId = await resolveMenuItemId(menuId);
      if (!itemId) return { reviews: [], average: 0, count: 0 };

      const { data, error } = await supabase
        .from(TABLES.reviews)
        .select("id, rating, comment, created_at")
        .eq("menu_item_id", itemId)
        .limit(50);
      if (error) throw error;

      const list = (data || []).map((r) => ({
        id: r.id,
        rating: Number(r.rating) || 0,
        comment: r.comment || "",
        name: "A customer",
        createdAt: r.created_at ? new Date(r.created_at) : null
      })).filter((r) => r.rating > 0);

      const average = list.length
        ? Math.round((list.reduce((n, r) => n + r.rating, 0) / list.length) * 10) / 10
        : 0;

      return { reviews: list, average, count: list.length };
    } catch {
      return { reviews: [], average: 0, count: 0 };
    }
  },

  /** Everything the signed-in customer has already rated, keyed by menu id. */
  async mine() {
    const uid = authService.uid();
    if (!uid) return {};
    try {
      const { data, error } = await supabase
        .from(TABLES.reviews)
        .select("menu_item_id, rating")
        .eq("user_id", uid)
        .limit(100);
      if (error) throw error;

      const byMenu = {};
      (data || []).forEach((r) => {
        if (r.menu_item_id) byMenu[r.menu_item_id] = Number(r.rating) || 0;
      });
      return byMenu;
    } catch {
      return {};
    }
  },

  /** Rate a dish. The unique index turns a re-rating into an update. */
  async rate({ menuId, rating, comment, orderId }) {
    const uid = authService.uid();
    if (!uid) throw new Error("Please sign in to leave a review.");

    const itemId = await resolveMenuItemId(menuId);
    if (!itemId) throw new Error("That dish is no longer on the menu.");

    const stars = Math.max(1, Math.min(5, Math.round(Number(rating) || 0)));

    /* reviews_insert_own requires the review to point at an order of the
       caller's that is BOTH paid and Completed — the database, not just the
       UI, enforces "you can only rate what you were actually delivered".
       Resolve it first so a missing or ineligible order produces a sentence a
       customer can read instead of a raw row-level-security error. */
    const orderUuid = await resolveOrderId(orderId, uid);
    if (!orderUuid) {
      throw new Error("You can only rate a dish from a completed order.");
    }

    const { error } = await supabase
      .from(TABLES.reviews)
      .upsert({
        user_id: uid,
        menu_item_id: itemId,
        order_id: orderUuid,
        rating: stars,
        comment: window.KT.rules.cleanString(comment || "", 500),
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id,menu_item_id" });

    if (error) throw error;
    return stars;
  }
};

export { errorMessage };
