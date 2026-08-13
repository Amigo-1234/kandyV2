/* ==========================================================================
   Kandy's Treats — Orders
   --------------------------------------------------------------------------
   Clients never write to `orders` or `orderItems` — firestore.rules forbids
   it. `createCheckoutOrder` re-prices every line from `menus/{id}`, verifies
   the saved address belongs to the caller, recalculates fees and coupons, and
   writes the order with the Admin SDK. This module only sends the draft and
   reads back what the server created.
   ========================================================================== */

import { db, fb, callable, COLLECTIONS } from "./firebase.js";
import { authService } from "./auth.js";

const createCheckoutOrder = callable("createCheckoutOrder");

/** Firestore order doc → the shape the order UI renders. */
function normalise(id, data) {
  const KT = window.KT;
  const created = data.createdAt && data.createdAt.toDate
    ? data.createdAt.toDate()
    : (data.createdAtMs ? new Date(data.createdAtMs) : null);

  const items = Array.isArray(data.items) && data.items.length
    ? data.items
    : (Array.isArray(data.subOrders) ? data.subOrders.flatMap((s) => s.items || []) : []);

  return {
    id: data.id || id,
    userId: data.userId,
    status: data.status || "New",
    statusLabel: (KT.rules.STATUS_META[data.status] || {}).label || data.status || "New",
    statusHistory: Array.isArray(data.statusHistory) ? data.statusHistory : [],
    fulfilment: data.fulfilment || "delivery",
    paid: data.paid === true,
    paymentStatus: data.paymentStatus || "pending",
    paymentProvider: data.paymentProvider || null,
    paymentRef: data.paymentRef || null,
    items,
    subOrders: Array.isArray(data.subOrders) ? data.subOrders : [],
    customer: data.customer || {},
    addressSnapshot: data.addressSnapshot || null,
    notes: data.notes || "",
    subtotal: Number(data.subtotal) || 0,
    deliveryFee: Number(data.deliveryFee) || 0,
    takeawayFee: Number(data.takeawayFee) || 0,
    discount: Number(data.discount) || 0,
    processingFee: Number(data.processingFee || data.vat) || 0,
    total: Number(data.total) || 0,
    estimatedDeliveryMinutes: Number(data.estimatedDeliveryMinutes) || 0,
    createdAt: created,
    itemCount: items.reduce((n, i) => n + (Number(i.qty) || 0), 0)
  };
}

export const orderService = {
  /**
   * Send the basket to the server for pricing and creation.
   * @param {Array} drafts   one draft per sub-order (V1 supports up to 10)
   * @param {'gateway'|'wallet'} paymentMode
   */
  async createCheckout(drafts, paymentMode = "gateway") {
    const result = await createCheckoutOrder({ drafts, paymentMode });
    /* The basket is only cleared once the server has an order on record. */
    window.KT.cart.clear();
    return result;
  },

  async list({ limit = 25 } = {}) {
    const uid = authService.uid();
    if (!uid) return [];

    const snap = await fb.getDocs(fb.query(
      fb.collection(db, COLLECTIONS.orders),
      fb.where("userId", "==", uid),
      fb.orderBy("createdAtMs", "desc"),
      fb.limit(limit)
    ));
    return snap.docs.map((d) => normalise(d.id, d.data()));
  },

  async get(orderId) {
    const snap = await fb.getDoc(fb.doc(db, COLLECTIONS.orders, orderId));
    if (!snap.exists()) return null;
    return normalise(snap.id, snap.data());
  },

  /** Live status updates while an order is in progress. */
  watch(orderId, onChange) {
    return fb.onSnapshot(
      fb.doc(db, COLLECTIONS.orders, orderId),
      (snap) => { if (snap.exists()) onChange(normalise(snap.id, snap.data())); },
      () => {}
    );
  },

  /** Put a past order's items back in the basket, skipping anything gone. */
  reorder(order) {
    let added = 0;
    let skipped = 0;
    (order.items || []).forEach((line) => {
      const id = line.menuId || line.id;
      if (window.KT.cart.add(id, Number(line.qty) || 1)) added += 1;
      else skipped += 1;
    });
    return { added, skipped };
  }
};
