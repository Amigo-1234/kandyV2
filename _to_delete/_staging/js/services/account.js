/* ==========================================================================
   Kandy's Treats — Customer profile
   `users/{uid}` is owner-readable and owner-writable, but firestore.rules
   pins the key set and stops anyone editing their own `role`.
   ========================================================================== */

import { db, fb, COLLECTIONS } from "./firebase.js";
import { authService } from "./auth.js";

export const accountService = {
  async profile() {
    const uid = authService.uid();
    if (!uid) return null;
    const snap = await fb.getDoc(fb.doc(db, COLLECTIONS.users, uid));
    const user = authService.user();
    const data = snap.exists() ? snap.data() : {};
    return {
      uid,
      displayName: data.displayName || (user && user.displayName) || "",
      email: data.email || (user && user.email) || "",
      phone: data.phone || "",
      photoURL: data.photoURL || (user && user.photoURL) || "",
      emailVerified: !!(user && user.emailVerified),
      role: data.role || "customer",
      createdAt: data.createdAt && data.createdAt.toDate ? data.createdAt.toDate() : null
    };
  },

  /** Only the fields firestore.rules whitelists — never `role`. */
  async updateProfile({ displayName, phone }) {
    const uid = authService.uid();
    if (!uid) throw new Error("Please sign in first.");
    const KT = window.KT;

    await fb.updateDoc(fb.doc(db, COLLECTIONS.users, uid), {
      displayName: KT.rules.cleanString(displayName, 120),
      phone: KT.rules.normalizePhone(phone),
      updatedAt: fb.serverTimestamp()
    });

    const user = authService.user();
    if (user && displayName) {
      await fb.updateProfile(user, { displayName }).catch(() => {});
    }
  },

  async notifications({ limit = 15 } = {}) {
    const uid = authService.uid();
    if (!uid) return [];
    const snap = await fb.getDocs(fb.query(
      fb.collection(db, COLLECTIONS.notifications),
      fb.where("userId", "==", uid),
      fb.orderBy("createdAt", "desc"),
      fb.limit(limit)
    ));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  async markNotificationRead(id) {
    const uid = authService.uid();
    if (!uid) return;
    await fb.updateDoc(fb.doc(db, COLLECTIONS.notifications, id), {
      userId: uid, read: true, readAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp()
    });
  },

  /** favourites/{uid_menuId} — the id shape V1 uses. */
  async favourites() {
    const uid = authService.uid();
    if (!uid) return [];
    const snap = await fb.getDocs(fb.query(
      fb.collection(db, COLLECTIONS.favourites),
      fb.where("userId", "==", uid)
    ));
    return snap.docs.map((d) => d.data().menuId).filter(Boolean);
  },

  async toggleFavourite(menuId) {
    const uid = authService.uid();
    if (!uid) throw new Error("Please sign in to save favourites.");
    const ref = fb.doc(db, COLLECTIONS.favourites, `${uid}_${menuId}`);
    const snap = await fb.getDoc(ref);
    if (snap.exists()) {
      await fb.deleteDoc(ref);
      return false;
    }
    await fb.setDoc(ref, { userId: uid, menuId, createdAt: fb.serverTimestamp() });
    return true;
  }
};
