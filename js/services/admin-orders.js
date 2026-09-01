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

   ONE PLACE THIS FILE IS NOT THE BOUNDARY
   ---------------------------------------
   Customer email is withheld from staff and supervisors here (canSeeEmail),
   matching admin_list_customers(), which returns null for that field below
   manager. That match is a UI courtesy and NOT an enforced boundary: the
   email lives inside the `customer` jsonb snapshot on the order row, and a
   column grant cannot cover half a jsonb. A staff member calling PostgREST
   directly can still read it. Closing that properly means the order list
   moving behind a SECURITY DEFINER RPC that redacts server-side, which is a
   schema decision rather than a UI one. Recorded here so nobody reads this
   code as proof of something it does not do.
   ========================================================================== */

import { supabase, TABLES, errorMessage } from "./supabase.js";

/* Columns the list needs. Deliberately explicit: it documents what the admin
   list reads, and avoids pulling address_snapshot/notes for every row.

   order_items(qty) is embedded rather than counted so a card can say "4 items"
   — a kitchen cares how much food is on the ticket, not how many distinct
   dishes. It is two integers per line and never the names or prices. */
const LIST_COLUMNS =
  "id, code, status, payment_status, payment_provider, paid, fulfilment, " +
  "customer, address_snapshot, subtotal, delivery_fee, takeaway_fee, discount, " +
  "processing_fee, total, created_at, updated_at, order_items(qty)";

/* The operational board, in the order a shift works through it. Terminal
   states come last because they are a record, not a queue. */
export const SECTIONS = [
  { status: "New",       title: "New",             hint: "Needs attention", active: true },
  { status: "Preparing", title: "Preparing",       hint: "In the kitchen",  active: true },
  { status: "Out",       title: "Out for delivery", hint: "With the rider", active: true },
  { status: "Completed", title: "Completed",       hint: "Done",            active: false },
  { status: "Cancelled", title: "Cancelled",       hint: "Written off",     active: false }
];

/* How many cards a section shows on the board before it defers to its own
   view. Live work is worth scrolling; finished work is worth a glance. */
const BOARD_LIMIT = { New: 25, Preparing: 25, Out: 25, Completed: 8, Cancelled: 8 };
export const PAGE_SIZE = 25;

/*
   "Today" must mean the same thing here as it does on the dashboard, and the
   dashboard asks Postgres via kt_today_start() — midnight in Africa/Lagos.
   Recomputing that in the browser from the viewer's own clock would put a
   handler in another timezone on a different day from the tiles they just
   clicked. Postgres is not asked for it per keystroke either: the boundary
   only moves once a day, so it is derived here from a fixed offset.

   Africa/Lagos is UTC+1 with no daylight saving — it has observed no DST
   since 1960, which is why a fixed offset is safe where it would not be for,
   say, Europe/London.
*/
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

export function lagosDayStart(daysBack) {
  const now = Date.now();
  const lagos = new Date(now + LAGOS_OFFSET_MS);
  /* Floor to midnight using the UTC accessors of the shifted clock: those
     read back the Lagos wall-clock date without involving the local zone. */
  const midnightLagos = Date.UTC(
    lagos.getUTCFullYear(), lagos.getUTCMonth(),
    lagos.getUTCDate() - (daysBack || 0));
  return new Date(midnightLagos - LAGOS_OFFSET_MS);
}

const RANGES = {
  today: () => lagosDayStart(0),
  "7d":  () => lagosDayStart(6),
  "30d": () => lagosDayStart(29),
  all:   () => null
};

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

function toRow(r, opts) {
  var c = r.customer || {};
  var snap = r.address_snapshot || {};
  var lines = r.order_items || [];
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
    /*
       §13: the Customers module hands staff and supervisors a null email —
       admin_list_customers() applies `case when is_manager() then email end`.
       Orders would otherwise be the back door to the same field, so the same
       rule is applied at the same tier. See the security note in the module
       header about what this does and does not guarantee.
    */
    customerEmail: (opts && opts.canSeeEmail === false) ? "" : (c.email || ""),
    /* Delivery-only, and only what a card needs to route the rider. */
    deliverTo: snap.recipientName || "",
    deliverPhone: snap.phone || "",
    deliverAddress: snap.address || "",
    riderNote: snap.notes || "",
    itemCount: lines.reduce(function (n, l) { return n + (Number(l.qty) || 0); }, 0),
    lineCount: lines.length,
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

/**
 * Every filter except status, applied in Postgres. Shared by the board and the
 * paged section list so a chip cannot mean one thing on one screen and
 * something else on the other.
 */
function applyFilters(q, opts) {
  if (opts.payment === "paid") q = q.eq("paid", true);
  if (opts.payment === "unpaid") q = q.eq("paid", false);
  if (opts.fulfilment && opts.fulfilment !== "all") q = q.eq("fulfilment", opts.fulfilment);

  var from = (RANGES[opts.range] || RANGES.all)();
  if (from) q = q.gte("created_at", from.toISOString());

  var term = String(opts.search || "").trim();
  if (term) {
    /* PostgREST splits an `or=` list on commas and reads parentheses as
       grouping, so those characters are stripped rather than escaped — a
       search box is not a query language. */
    var like = "*" + term.replace(/[*,()]/g, "") + "*";
    var fields = [
      "code.ilike." + like,
      "customer->>name.ilike." + like,
      "customer->>phone.ilike." + like
    ];
    /* §15: a role that is not shown an email does not get to search by one
       either — matching on a hidden field leaks it one guess at a time. */
    if (opts.canSeeEmail !== false) fields.push("customer->>email.ilike." + like);
    q = q.or(fields.join(","));
  }
  return q;
}

export const adminOrderService = {
  nextStatuses: nextStatuses,
  SECTIONS: SECTIONS,
  PAGE_SIZE: PAGE_SIZE,
  lagosDayStart: lagosDayStart,

  /**
   * One section, paged. `count: "exact"` is what lets the heading say how many
   * orders are really in that state rather than how many were fetched.
   */
  async section(status, opts) {
    opts = opts || {};
    var limit = opts.limit || PAGE_SIZE;
    var offset = opts.offset || 0;
    var q = supabase.from(TABLES.orders)
      .select(LIST_COLUMNS, { count: "exact" })
      .eq("status", status);
    q = applyFilters(q, opts);

    var res = await q.order("created_at", { ascending: false })
                     .range(offset, offset + limit - 1);
    if (res.error) throw res.error;
    var rows = (res.data || []).map(function (r) { return toRow(r, opts); });
    return {
      status: status,
      rows: rows,
      total: typeof res.count === "number" ? res.count : rows.length,
      hasMore: offset + rows.length < (res.count || 0)
    };
  },

  /**
   * The whole board: every operational state, each counted and capped on its
   * own. Deliberately NOT one query sliced in the browser — a hundred finished
   * orders would otherwise push the new ones off the page, which is precisely
   * backwards for the screen a kitchen works from.
   */
  async board(opts) {
    opts = opts || {};
    var results = await Promise.all(SECTIONS.map(function (sec) {
      return adminOrderService.section(sec.status, Object.assign({}, opts, {
        limit: BOARD_LIMIT[sec.status] || PAGE_SIZE, offset: 0
      }));
    }));
    return results;
  },

  /**
   * Flat list. Kept because the dashboard's recent-orders deep link and the
   * board both need "find me this one order", and because a single status
   * view is just a section with a bigger page.
   */
  async list(opts) {
    opts = opts || {};
    var q = supabase.from(TABLES.orders).select(LIST_COLUMNS);
    if (opts.status && opts.status !== "all") q = q.eq("status", opts.status);
    q = applyFilters(q, opts);
    var res = await q.order("created_at", { ascending: false })
                     .limit(opts.limit || PAGE_SIZE);
    if (res.error) throw res.error;
    return (res.data || []).map(function (r) { return toRow(r, opts); });
  },

  /** One order with its lines, status history and a little customer context. */
  async get(code, opts) {
    opts = opts || {};
    var head = await supabase.from(TABLES.orders)
      .select("*").eq("code", code).maybeSingle();
    if (head.error) throw head.error;
    if (!head.data) return null;

    /* toRow reads order_items off the row for its count; the detail fetches
       the real lines below, so give it an empty set rather than a wrong one. */
    var order = toRow(Object.assign({ order_items: [] }, head.data), opts);
    order.notes = head.data.notes || "";
    order.couponCode = head.data.coupon_code || null;
    order.paymentRef = head.data.payment_ref || null;
    order.addressSnapshot = head.data.address_snapshot || null;
    order.vat = Number(head.data.vat) || 0;
    order.estimatedMinutes = head.data.estimated_minutes || null;
    order.userId = head.data.user_id || null;

    var lines = await supabase.from("order_items")
      .select("id, name, qty, unit_price, line_total")
      .eq("order_id", head.data.id);
    if (lines.error) throw lines.error;
    order.items = (lines.data || []).map(function (l) {
      return { id: l.id, name: l.name, qty: l.qty,
               unitPrice: Number(l.unit_price) || 0,
               lineTotal: Number(l.line_total) || 0 };
    });

    /*
       created_by has been recorded on every handler action since Phase 5 and
       was simply never read — the screen showed the note the trigger writes
       ("Updated by owner."), which names the ROLE that acted rather than the
       person.

       Read through admin_order_history() rather than the table: the column
       grant on order_status_history deliberately excludes created_by, because
       a customer can read their own order's history and an internal staff id
       has no business travelling with it. The function is is_admin()-gated —
       the same boundary the direct read had — and returns the actor already
       resolved, which is one round trip where this used to take two.
    */
    var hist = await supabase.rpc("admin_order_history", { p_order_id: head.data.id });
    if (hist.error) throw hist.error;

    order.history = (hist.data || []).map(function (h) {
      return { id: h.id, status: h.status, note: h.note || "",
               at: h.created_at ? new Date(h.created_at) : null,
               actorId: h.actor_id || null,
               actorName: h.actor_name || "",
               actorRole: h.actor_role || null };
    });

    /*
       RESPONSIBILITY, DERIVED
       -----------------------
       Two different questions the brief asks to keep apart:

         pickedUpBy   who took the order on — the actor of the first move
                      away from New. This is the closest thing to "who is
                      responsible", and it is a fact rather than a field, so
                      it can never disagree with the history beneath it.
         lastActionBy who acted most recently, which may well be somebody
                      else covering.

       No assigned_to column: with a two-person kitchen where eight of nine
       orders were carried end to end by one person, allocation is not the
       workflow. If that changes, this derivation is what a real column would
       have to agree with anyway.
    */
    var moves = order.history.filter(function (h) {
      return h.actorId && h.status !== "New";
    });
    order.pickedUpBy = moves.length ? moves[0] : null;
    var acted = order.history.filter(function (h) { return h.actorId; });
    order.lastActionBy = acted.length ? acted[acted.length - 1] : null;
    order.handlerCount = acted.reduce(function (set, h) {
      if (set.indexOf(h.actorId) === -1) set.push(h.actorId);
      return set;
    }, []).length;

    order.itemCount = order.items.reduce(function (n, l) { return n + l.qty; }, 0);
    order.lineCount = order.items.length;

    /*
       §13: enough context to recognise a regular or a first-timer, read from
       the orders the caller can already see. Deliberately NOT a call into the
       customer module — that one audits every open and returns a home
       address, neither of which belongs in a ticket view.
    */
    if (head.data.user_id) {
      var ctx = await supabase.from(TABLES.orders)
        .select("code, status, total, created_at", { count: "exact" })
        .eq("user_id", head.data.user_id)
        .neq("id", head.data.id)
        .order("created_at", { ascending: false })
        .limit(3);
      if (!ctx.error) {
        order.customerOrderCount = (ctx.count || 0) + 1;
        order.customerRecent = (ctx.data || []).map(function (o) {
          return { code: o.code, status: o.status, total: Number(o.total) || 0,
                   at: o.created_at ? new Date(o.created_at) : null };
        });
      }
    }

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
