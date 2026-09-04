/* ==========================================================================
   Kandy's Treats — Orders (Supabase)
   --------------------------------------------------------------------------
   The browser never prices an order. create_checkout_order() is a SECURITY
   DEFINER Postgres function that re-reads every price from menu_items,
   re-derives fees and coupons, verifies the address belongs to the caller and
   writes the order in one transaction. This module only sends menu ids and
   quantities, then reads back what the server created.

   RLS denies INSERT/UPDATE/DELETE on orders, order_items and
   order_status_history to customers outright, so that RPC is the only way an
   order can come into existence — there is no client-side path to fall back
   to, by design.

   `id` is deliberately the human-readable code (KD-260814-0001) rather than
   the uuid, because that is what the UI prints and puts in URLs.
   ========================================================================== */

import { supabase, TABLES, errorMessage } from "./supabase.js";
import { authService } from "./auth.js";

const ORDER_SELECT = `
  id, code, user_id, status, payment_status, payment_provider, payment_ref, paid,
  fulfilment, address_id, address_snapshot, customer, notes,
  subtotal, delivery_fee, takeaway_fee, discount, vat, processing_fee, total,
  coupon_code, estimated_minutes, created_at,
  order_items ( menu_item_id, name, unit_price, qty, line_total ),
  order_status_history ( status, note, created_at )
`;

/** orders row (+ children) → the shape every order page already reads. */
function normalise(row) {
  const KT = window.KT;
  const items = (row.order_items || []).map((l) => ({
    menuId: l.menu_item_id,
    id: l.menu_item_id,
    name: l.name,
    price: Number(l.unit_price) || 0,
    qty: Number(l.qty) || 0,
    lineTotal: Number(l.line_total) || 0
  }));

  const history = (row.order_status_history || [])
    .slice()
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map((h) => ({ status: h.status, note: h.note, at: new Date(h.created_at) }));

  return {
    id: row.code,
    uuid: row.id,
    userId: row.user_id,
    status: row.status || "New",
    /* statusMeta(), not STATUS_META[], so a pickup order's badge says
       "Ready for collection" rather than "Out for delivery" — the map alone
       has no idea how the order ships. */
    statusLabel: (KT.rules.statusMeta(row.status, row.fulfilment || "delivery") || {}).label
      || row.status || "New",
    statusHistory: history,
    fulfilment: row.fulfilment || "delivery",
    paid: row.paid === true,
    paymentStatus: row.payment_status || "pending",
    paymentProvider: row.payment_provider || null,
    paymentRef: row.payment_ref || null,
    items,
    subOrders: [],
    customer: row.customer || {},
    addressSnapshot: row.address_snapshot || null,
    notes: row.notes || "",
    subtotal: Number(row.subtotal) || 0,
    deliveryFee: Number(row.delivery_fee) || 0,
    takeawayFee: Number(row.takeaway_fee) || 0,
    discount: Number(row.discount) || 0,
    processingFee: Number(row.processing_fee || row.vat) || 0,
    total: Number(row.total) || 0,
    couponCode: row.coupon_code || null,
    estimatedDeliveryMinutes: Number(row.estimated_minutes) || 0,
    createdAt: row.created_at ? new Date(row.created_at) : null,
    itemCount: items.reduce((n, i) => n + i.qty, 0)
  };
}

/* Double-submit guard. An identical basket resubmitted inside this window
   reuses the same idempotency key, so the RPC hands back the FIRST order
   instead of creating a second one. A genuine repeat order later gets a fresh
   key and is allowed through. */
const REPLAY_WINDOW = 120 * 1000;
let pending = null;

function draftFingerprint(draft, uid) {
  const lines = (draft.items || [])
    .map((i) => `${i.menuId || i.id}x${i.qty}`)
    .sort()
    .join("|");
  return [uid, draft.fulfilment, draft.addressId || "",
          (draft.coupon && draft.coupon.code) || "", lines].join("::");
}

function idempotencyKeyFor(draft, uid) {
  const print = draftFingerprint(draft, uid);
  if (pending && pending.print === print && Date.now() - pending.at < REPLAY_WINDOW) {
    return pending.key;
  }
  const key = (crypto.randomUUID ? crypto.randomUUID()
                                 : String(Date.now()) + Math.random().toString(16).slice(2));
  pending = { print, key, at: Date.now() };
  return key;
}

export const orderService = {
  /**
   * Send the basket to the server for pricing and creation.
   * Only ids and quantities travel — never a price.
   * @param {Array} drafts one draft (the sub-order shape V1 used is collapsed)
   */
  async createCheckout(drafts) {
    const uid = authService.uid();
    if (!uid) throw new Error("Please sign in to place your order.");

    const draft = Array.isArray(drafts) ? drafts[0] : drafts;
    if (!draft) throw new Error("Your basket is empty.");

    const { data, error } = await supabase.rpc("create_checkout_order", {
      p_items: (draft.items || []).map((i) => ({
        menu_id: i.menuId || i.id,
        qty: Number(i.qty) || 0
      })),
      p_fulfilment: draft.fulfilment || "delivery",
      p_address_id: draft.addressId || null,
      p_coupon_code: (draft.coupon && draft.coupon.code) || null,
      p_notes: draft.notes || "",
      p_customer: draft.customer || {},
      p_idempotency_key: idempotencyKeyFor(draft, uid)
    });

    if (error) throw error;

    /* Only clear the basket once the server has an order on record. */
    window.KT.cart.clear();
    pending = null;
    return { orderId: data.code, uuid: data.orderId, total: data.total,
             duplicate: !!data.duplicate };
  },

  async list({ limit = 25 } = {}) {
    const uid = authService.uid();
    if (!uid) return [];

    const { data, error } = await supabase
      .from(TABLES.orders)
      .select(ORDER_SELECT)
      .eq("user_id", uid)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data || []).map(normalise);
  },

  /** Accepts the human code (what the UI carries) or the uuid. */
  async get(orderId) {
    const uid = authService.uid();
    if (!uid || !orderId) return null;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId);
    const { data, error } = await supabase
      .from(TABLES.orders)
      .select(ORDER_SELECT)
      .eq(isUuid ? "id" : "code", orderId)
      .eq("user_id", uid)
      .maybeSingle();
    if (error) throw error;
    return data ? normalise(data) : null;
  },

  /** Live status updates while an order is in progress (Supabase Realtime). */
  watch(orderId, onChange) {
    const uid = authService.uid();
    if (!uid || !orderId) return () => {};

    const channel = supabase
      .channel(`kt-order-${orderId}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: TABLES.orders, filter: `user_id=eq.${uid}` },
        async () => {
          try {
            const fresh = await orderService.get(orderId);
            if (fresh) onChange(fresh);
          } catch { /* keep whatever we have */ }
        })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
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

export { errorMessage };
