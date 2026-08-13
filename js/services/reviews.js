/* ==========================================================================
   Kandy's Treats — Reviews
   --------------------------------------------------------------------------
   V1 defines `reviews/{uid_menuId}` — one review per customer per dish, so a
   second review replaces the first rather than stacking. firestore.rules make
   them publicly readable but owner-writable, which is what lets the menu show
   an average to guests.

   Customers can only review a dish they have actually been delivered: the
   rating UI lives on a Completed order, never on the product page cold.
   ========================================================================== */

import { db, fb, COLLECTIONS } from "./firebase.js";
import { authService } from "./auth.js";

/** reviews/{uid}_{menuId} — the id shape V1 uses. */
function reviewId(uid, menuId) {
  return `${uid}_${menuId}`;
}

export const reviewService = {
  /** Public: every review for one dish, plus its average. */
  async forItem(menuId) {
    try {
      const snap = await fb.getDocs(fb.query(
        fb.collection(db, COLLECTIONS.reviews),
        fb.where("menuId", "==", menuId),
        fb.limit(50)
      ));
      const list = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          rating: Number(data.rating) || 0,
          comment: data.comment || "",
          name: data.name || "A customer",
          createdAt: data.createdAt && data.createdAt.toDate ? data.createdAt.toDate() : null
        };
      }).filter((r) => r.rating > 0);

      const average = list.length
        ? Math.round((list.reduce((n, r) => n + r.rating, 0) / list.length) * 10) / 10
        : 0;

      return { reviews: list, average, count: list.length };
    } catch {
      return { reviews: [], average: 0, count: 0 };
    }
  },

  /** Everything the signed-in customer has already rated. */
  async mine() {
    const uid = authService.uid();
    if (!uid) return {};
    try {
      const snap = await fb.getDocs(fb.query(
        fb.collection(db, COLLECTIONS.reviews),
        fb.where("userId", "==", uid),
        fb.limit(100)
      ));
      const byMenu = {};
      snap.docs.forEach((d) => {
        const data = d.data();
        if (data.menuId) byMenu[data.menuId] = Number(data.rating) || 0;
      });
      return byMenu;
    } catch {
      return {};
    }
  },

  /**
   * Rate a dish. Writing to a deterministic id means re-rating updates the
   * existing review instead of creating a duplicate.
   */
  async rate({ menuId, rating, comment, orderId }) {
    const uid = authService.uid();
    if (!uid) throw new Error("Please sign in to leave a review.");

    const stars = Math.max(1, Math.min(5, Math.round(Number(rating) || 0)));
    const profile = authService.user();

    await fb.setDoc(fb.doc(db, COLLECTIONS.reviews, reviewId(uid, menuId)), {
      userId: uid,
      menuId,
      rating: stars,
      comment: window.KT.rules.cleanString(comment || "", 500),
      orderId: window.KT.rules.cleanString(orderId || "", 60) || null,
      name: (profile && profile.displayName) || "A customer",
      createdAt: fb.serverTimestamp(),
      updatedAt: fb.serverTimestamp()
    }, { merge: true });

    return stars;
  }
};
