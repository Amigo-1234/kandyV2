/* ==========================================================================
   Kandy's Treats — Admin orders service
   --------------------------------------------------------------------------
   Loaded on demand by the admin app only, so the storefront never pays for it.
   It imports the SAME supabase.js singleton the customer services use — there
   is no second client, no second auth.

   Every call here is ordinary PostgREST. Nothing is privileged by virtue of
   living in this file: an admin sees all orders because RLS says
   `user_id = auth.uid() OR is_admin()`, and a staff member is refused a
   cancellation because a trigger says so. If this module were called by a
   customer it would simply return their own orders.
   ========================================================================== */

import { supabase, TABLES, errorMessage } from "./supabase.js";

/* Columns the list needs. Deliberately explicit: it documents what the admin
   list reads, and avoids pulling address_snapshot/notes for every row. */
const LIST_COLUMNS =
  "id, code, status, payment_status, payment_provider, paid, fulfilment, " +
  "customer, subtotal, delivery_fee, takeaway_fee, discount, processing_fee, " +
  "total, created_at, updated_at";

const STATUS_FLOW = {
  New: ["Preparing", "Cancelled"],
  Preparing: ["Out", "Cancelled"],
  Out: ["Completed", "Cancelled"],
  Completed: [],
  Cancelled: []
};

/** Mirrors the DB trigger so the UI can offer only moves the server will take. */
export function nextStatuses(current) {
  return (STATUS_FLOW[current] || []).slice();
}

function toRow(r) {
  var c = r.customer || {};
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    paymentStatus: r.payment_status,
    paymentProvider: r.payment_provider,
    paid: r.paid === true,
    fulfilment: r.fulfilment,
    customerName: c.name || "",
    customerPhone: c.phone || "",
    customerEmail: c.email || "",
    subtotal: Number(r.subtotal) || 0,
    deliveryFee: Number(r.delivery_fee) || 0,
    takeawayFee: Number(r.takeaway_fee) || 0,
    discount: Number(r.discount) || 0,
    processingFee: Number(r.processing_fee) || 0,
    total: Number(r.total) || 0,
    createdAt: r.created_at ? new Date(r.created_at) : null,
    updatedAt: r.updated_at ? new Date(r.updated_at) : null
  };
}

export const adminOrderService = {
  nextStatuses: nextStatuses,

  /**
   * Server-backed list. Filtering and search run in Postgres, not the browser,
   * so this stays correct once there are more orders than fit in one page.
   */
  async list(opts) {
    opts = opts || {};
    var q = supabase.from(TABLES.orders).select(LIST_COLUMNS);

    if (opts.status && opts.status !== "all") q = q.eq("status", opts.status);
    if (opts.payment === "paid") q = q.eq("paid", true);
    if (opts.payment === "unpaid") q = q.eq("paid", false);

    var term = String(opts.search || "").trim();
    if (term) {
      /* Order code, or any of the customer fields on the order snapshot. */
      var like = "*" + term.replace(/[*,()]/g, "") + "*";
      q = q.or([
        "code.ilike." + like,
        "customer->>name.ilike." + like,
        "customer->>email.ilike." + like,
        "customer->>phone.ilike." + like
      ].join(","));
    }

    var res = await q.order("created_at", { ascending: false })
                     .limit(opts.limit || 100);
    if (res.error) throw res.error;
    return (res.data || []).map(toRow);
  },

  /** One order with its lines and status history. */
  async get(code) {
    var head = await supabase.from(TABLES.orders)
      .select("*").eq("code", code).maybeSingle();
    if (head.error) throw head.error;
    if (!head.data) return null;

    var order = toRow(head.data);
    order.notes = head.data.notes || "";
    order.couponCode = head.data.coupon_code || null;
    order.paymentRef = head.data.payment_ref || null;
    order.addressSnapshot = head.data.address_snapshot || null;
    order.vat = Number(head.data.vat) || 0;

    var lines = await supabase.from("order_items")
      .select("id, name, qty, unit_price, line_total")
      .eq("order_id", head.data.id);
    if (lines.error) throw lines.error;
    order.items = (lines.data || []).map(function (l) {
      return { id: l.id, name: l.name, qty: l.qty,
               unitPrice: Number(l.unit_price) || 0,
               lineTotal: Number(l.line_total) || 0 };
    });

    var hist = await supabase.from("order_status_history")
      .select("id, status, note, created_at")
      .eq("order_id", head.data.id)
      .order("created_at", { ascending: true });
    if (hist.error) throw hist.error;
    order.history = (hist.data || []).map(function (h) {
      return { id: h.id, status: h.status, note: h.note || "",
               at: h.created_at ? new Date(h.created_at) : null };
    });

    return order;
  },

  /**
   * Advance or cancel. ONLY `status` is sent — every money and payment column
   * is unreachable from any client role anyway (no column grant), so this
   * cannot become a price or payment edit even by mistake.
   */
  async setStatus(code, status) {
    var res = await supabase.from(TABLES.orders)
      .update({ status: status, updated_at: new Date().toISOString() })
      .eq("code", code)
      .select("code, status, updated_at");
    if (res.error) throw res.error;
    if (!res.data || !res.data.length) {
      /* RLS filtered it: the caller may read the order but not change it. */
      throw new Error("That order could not be updated with your access level.");
    }
    return res.data[0];
  },

  /**
   * Live updates over the existing Supabase Realtime channel. Returns an
   * unsubscribe function; the caller owns the lifecycle so re-entering the
   * view cannot stack duplicate channels.
   */
  watch(onChange, onStatus) {
    var channel = supabase
      .channel("admin-orders")
      .on("postgres_changes",
          { event: "*", schema: "public", table: "orders" },
          function (payload) { onChange(payload); })
      .subscribe(function (status) { if (onStatus) onStatus(status); });

    return function unsubscribe() { supabase.removeChannel(channel); };
  }
};

export { errorMessage };
