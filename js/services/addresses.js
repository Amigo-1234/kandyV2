/* ==========================================================================
   Kandy's Treats — Saved delivery addresses
   --------------------------------------------------------------------------
   Kandy's serves Lagos State only for this release, so there is no geocoding
   and no GPS: the customer types the address themselves and saves it for
   reuse, exactly as V1 does.

   Writes go through the callable functions first (saveCustomerAddress,
   deleteCustomerAddress, setDefaultCustomerAddress) because those run with
   Admin SDK permissions and keep the "only one default" rule. If the callable
   is unavailable we fall back to strict owner-only Firestore writes, which
   firestore.rules already restricts to `addressKeysOnly()` + `ownsIncoming()`.
   ========================================================================== */

import { db, fb, callable, COLLECTIONS } from "./firebase.js";
import { authService } from "./auth.js";

const saveCustomerAddress = callable("saveCustomerAddress");
const deleteCustomerAddress = callable("deleteCustomerAddress");
const setDefaultCustomerAddress = callable("setDefaultCustomerAddress");

/* Callable failures that mean "the function never ran", as opposed to "the
   function ran and refused". Only the first kind is safe to retry directly
   against Firestore — firestore.rules re-checks ownership there anyway, so
   the fallback cannot widen access. A permission-denied or unauthenticated
   is a real answer and must surface, not silently take the other path.

   The previous list was not-found + internal only, which meant a blocked
   origin or a dropped connection (unavailable / failed-precondition, or a
   CORS rejection with no code at all) skipped the fallback entirely — the
   one situation it exists for. */
const TRANSPORT_FAILURES = [
  "not-found",           /* function not deployed to this project */
  "internal",            /* cold-start crash, emulator not running */
  "unavailable",         /* offline, DNS, blocked origin */
  "deadline-exceeded",
  "failed-precondition",
  "cancelled",
  "resource-exhausted",
  "aborted"
];

function neverRan(error) {
  const code = String((error && error.code) || "").toLowerCase();
  /* A CORS or network rejection arrives as an opaque error with no code. */
  if (!code) return true;
  return TRANSPORT_FAILURES.some((c) => code.includes(c));
}

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

export const addressService = {
  async list() {
    const uid = authService.uid();
    if (!uid) return [];

    const snap = await fb.getDocs(fb.query(
      fb.collection(db, COLLECTIONS.addresses),
      fb.where("userId", "==", uid)
    ));

    return snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
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

    try {
      const result = await saveCustomerAddress({ addressId: payload.id || null, address: body });
      return { id: (result && result.addressId) || payload.id };
    } catch (error) {
      if (!neverRan(error)) throw error;

      try {
        const now = fb.serverTimestamp();
        if (payload.id) {
          await fb.updateDoc(fb.doc(db, COLLECTIONS.addresses, payload.id),
            { ...body, userId: uid, updatedAt: now });
          return { id: payload.id };
        }
        const ref = await fb.addDoc(fb.collection(db, COLLECTIONS.addresses),
          { ...body, userId: uid, createdAt: now, updatedAt: now });
        return { id: ref.id };
      } catch (fallbackError) {
        /* Surface the original failure: it says why the callable was missed,
           which is the more useful half of the diagnosis. */
        console.warn("[Kandy's] address fallback also failed:", fallbackError);
        throw error;
      }
    }
  },

  async remove(addressId) {
    try {
      await deleteCustomerAddress({ addressId });
    } catch (error) {
      if (!neverRan(error)) throw error;
      await fb.deleteDoc(fb.doc(db, COLLECTIONS.addresses, addressId));
    }
  },

  async makeDefault(addressId) {
    try {
      await setDefaultCustomerAddress({ addressId });
    } catch (error) {
      if (!neverRan(error)) throw error;
      const uid = authService.uid();
      const all = await addressService.list();
      await Promise.all(all.map((a) => fb.updateDoc(
        fb.doc(db, COLLECTIONS.addresses, a.id),
        { userId: uid, isDefault: a.id === addressId, updatedAt: fb.serverTimestamp() }
      )));
    }
  }
};
