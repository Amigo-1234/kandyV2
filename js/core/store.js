/* ==========================================================================
   Kandy's Treats — Client-side basket
   --------------------------------------------------------------------------
   Models V1's cart exactly: a basket is a flat list of {menuId, qty}. There
   are no per-item add-ons — Kandy's sells proteins, sides and drinks as their
   own menu items, so choosing "add a protein" on a product page simply adds
   another line with its own menuId. That is what lets the server verify the
   whole basket against `menus/{id}` at checkout.

   Storage mirrors V1's scoping (`kandys_cart_<uid|guest>`) so a guest basket
   survives sign-in and merges into the account basket.

   Totals are computed by KT.rules, which mirrors functions/index.js. The
   server recalculates everything in `createCheckoutOrder` — these numbers are
   an accurate preview, never the charge.
   ========================================================================== */
(function (KT) {
  "use strict";

  var cfg = KT.config;
  var listeners = [];
  var scope = cfg.storage.guestScope;

  var state = {
    lines: [],                 // [{ menuId, qty, group }]
    fulfilment: "delivery",    // delivery | pickup
    couponCode: "",
    notes: "",
    /* How many takeaway packs the customer has opened. 0 means grouping is
       off entirely and every line carries group:null — the behaviour this
       basket had before Phase 12, byte for byte. */
    groups: 0,
    /* Which pack a bare add() lands in. Null whenever grouping is off. */
    activeGroup: null
  };

  var MAX_GROUPS = 20;

  /* ---- Line identity --------------------------------------------------- */

  /*
     A basket line is identified by menu item AND pack, not by menu item
     alone. Jollof ×2 in pack 1 and Jollof ×1 in pack 2 are two lines; before
     Phase 12 they collapsed into Jollof ×3 and the grouping was destroyed in
     the basket, long before anything reached the server.

     The composite is a string so it can live in a data- attribute. Group 0
     in the key means "no pack", which is the null case.
  */
  function keyOf(menuId, group) {
    return String(menuId) + "#" + (group == null ? 0 : group);
  }

  /*
     Callers may pass either a bare menuId or a composite key. The menu grid
     and the product modal know nothing about packs and pass a bare id — that
     resolves against the ACTIVE pack, which is what "add this to the basket"
     means while a pack is selected. The basket screens pass the composite,
     because they are addressing one line among several for the same item.
  */
  function parseRef(ref) {
    var s = String(ref == null ? "" : ref);
    var hash = s.lastIndexOf("#");
    if (hash === -1) return { menuId: s, group: state.activeGroup };
    var g = Number(s.slice(hash + 1));
    return {
      menuId: s.slice(0, hash),
      group: g >= 1 && g <= MAX_GROUPS ? Math.trunc(g) : null
    };
  }

  /** Null unless grouping is on and the value is a real pack number. */
  function cleanGroup(value) {
    if (value == null) return null;
    var n = Math.trunc(Number(value));
    if (!(n >= 1 && n <= MAX_GROUPS)) return null;
    return n > state.groups ? null : n;
  }

  /* ---- Persistence ---------------------------------------------------- */

  function key(base) {
    return base + "_" + scope;
  }

  /*
     Upgrades a basket saved before Phase 12 without disturbing it. An old
     line is {menuId, qty} and becomes {menuId, qty, group:null} — still one
     basket, still ungrouped, nothing silently scattered across packs the
     customer never asked for. The upgraded shape is not written back here;
     it persists on the next real change, so simply opening the site does not
     rewrite storage.
  */
  function normaliseLines(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map(function (l) {
        if (!l || !l.menuId) return null;
        var qty = Math.trunc(Number(l.qty) || 0);
        if (qty <= 0) return null;
        var g = Math.trunc(Number(l.group));
        return {
          menuId: String(l.menuId),
          qty: Math.min(cfg.limits.maxQty, qty),
          group: g >= 1 && g <= MAX_GROUPS ? g : null
        };
      })
      .filter(Boolean);
  }

  function read() {
    try {
      var raw = localStorage.getItem(key(cfg.storage.cart));
      var parsed = raw ? JSON.parse(raw) : null;
      if (!parsed) return;
      if (Array.isArray(parsed)) {
        state.lines = normaliseLines(parsed);
      } else {
        state.lines = normaliseLines(parsed.lines);
        state.fulfilment = parsed.fulfilment === "pickup" ? "pickup" : "delivery";
        state.couponCode = parsed.couponCode || "";
        state.notes = parsed.notes || "";
        state.groups = Math.min(MAX_GROUPS, Math.max(0, Math.trunc(Number(parsed.groups) || 0)));
      }
      /* A stored basket can only claim as many packs as its lines justify —
         a truncated or hand-edited value must never leave a line pointing at
         a pack that no longer exists. */
      var highest = state.lines.reduce(function (n, l) {
        return l.group && l.group > n ? l.group : n;
      }, 0);
      if (highest > state.groups) state.groups = Math.min(MAX_GROUPS, highest);
      state.activeGroup = state.groups > 0 ? 1 : null;
    } catch (e) {
      state.lines = [];
      state.groups = 0;
      state.activeGroup = null;
    }
  }

  function write() {
    try {
      localStorage.setItem(key(cfg.storage.cart), JSON.stringify(state));
    } catch (e) {
      /* private mode — the basket simply lives in memory for this session */
    }
    emit();
  }

  function emit() {
    var snap = cart.summary();
    listeners.forEach(function (fn) { fn(cart.detailed(), snap); });
  }

  /* ---- Reading -------------------------------------------------------- */

  function lineFor(menuId, group) {
    var g = group == null ? null : group;
    return state.lines.filter(function (l) {
      return l.menuId === menuId && (l.group == null ? null : l.group) === g;
    })[0];
  }

  var cart = {
    /** Current storage scope — 'guest' or a Firebase uid. */
    scope: function () { return scope; },

    lines: function () { return state.lines.slice(); },

    fulfilment: function () { return state.fulfilment; },

    setFulfilment: function (value) {
      state.fulfilment = value === "pickup" ? "pickup" : "delivery";
      write();
    },

    notes: function () { return state.notes; },

    setNotes: function (value) {
      state.notes = KT.rules.cleanString(value, 500);
      write();
    },

    coupon: function () { return KT.rules.coupon(state.couponCode); },

    /** @returns {{ok:boolean, message:string}} */
    applyCoupon: function (code) {
      var clean = KT.rules.cleanString(code, 30).toUpperCase();
      if (!clean) {
        state.couponCode = "";
        write();
        return { ok: true, message: "Coupon removed." };
      }
      var coupon = KT.rules.coupon(clean);
      if (!coupon) return { ok: false, message: "That code is not recognised." };

      var subtotal = cart.summary().subtotal;
      if (subtotal < coupon.minSubtotal) {
        return {
          ok: false,
          message: coupon.code + " needs a subtotal of at least " +
            KT.rules.formatPrice(coupon.minSubtotal) + "."
        };
      }
      state.couponCode = coupon.code;
      write();
      return { ok: true, message: coupon.label + " applied." };
    },

    count: function () {
      return state.lines.reduce(function (n, l) { return n + l.qty; }, 0);
    },

    /*
       The quantity of an item in ONE pack when a composite key is given, and
       the quantity across the whole basket when a bare menu id is given while
       grouping is off. The menu grid's stepper asks the bare question and
       must keep showing the number the customer expects to see under the
       card, so with grouping on it reports the active pack's count.
    */
    qtyOf: function (ref) {
      var r = parseRef(ref);
      var line = lineFor(r.menuId, r.group);
      return line ? line.qty : 0;
    },

    /* ---- Writing ------------------------------------------------------ */

    add: function (ref, qty) {
      var r = parseRef(ref);
      var item = KT.menu.byId(r.menuId);
      if (!item || !KT.menu.available(item)) return false;
      qty = Math.max(1, Math.trunc(Number(qty) || 1));

      var group = cleanGroup(r.group);
      var line = lineFor(r.menuId, group);
      if (line) {
        line.qty = Math.min(cfg.limits.maxQty, line.qty + qty);
      } else {
        if (state.lines.length >= cfg.limits.maxItems) return false;
        state.lines.push({
          menuId: r.menuId,
          qty: Math.min(cfg.limits.maxQty, qty),
          group: group
        });
      }
      write();
      return true;
    },

    setQty: function (ref, qty) {
      qty = Math.trunc(Number(qty) || 0);
      if (qty <= 0) return cart.remove(ref);
      var r = parseRef(ref);
      var line = lineFor(r.menuId, cleanGroup(r.group));
      if (line) line.qty = Math.min(cfg.limits.maxQty, qty);
      write();
    },

    bump: function (ref, delta) {
      var r = parseRef(ref);
      var line = lineFor(r.menuId, cleanGroup(r.group));
      if (!line) {
        if (delta > 0) cart.add(ref, delta);
        return;
      }
      cart.setQty(keyOf(r.menuId, line.group), line.qty + delta);
    },

    remove: function (ref) {
      var r = parseRef(ref);
      var g = cleanGroup(r.group);
      state.lines = state.lines.filter(function (l) {
        return !(l.menuId === r.menuId && (l.group == null ? null : l.group) === g);
      });
      write();
    },

    clear: function () {
      state.lines = [];
      state.couponCode = "";
      state.notes = "";
      state.groups = 0;
      state.activeGroup = null;
      write();
    },

    /* ---- Takeaway packs ------------------------------------------------ */

    /*
       Grouping is OPERATIONAL, not financial. A pack tells the kitchen which
       items go in which bag; it does not touch subtotal, packaging, delivery,
       discount or total, and the server recomputes all of those from the menu
       regardless of what this basket claims. Turning grouping on cannot make
       an order cost more or less.

       Labels are generated — "Takeaway 1", "Takeaway 2" — and the customer is
       never asked to type one.
    */
    groupCount: function () { return state.groups; },
    maxGroups: function () { return MAX_GROUPS; },
    grouped: function () { return state.groups > 0; },
    activeGroup: function () { return state.activeGroup; },
    groupLabel: function (group) {
      return group == null ? "Ungrouped" : "Takeaway " + group;
    },
    keyOf: keyOf,

    setActiveGroup: function (group) {
      var g = cleanGroup(group);
      if (state.groups === 0) return;
      state.activeGroup = g == null ? 1 : g;
      emit();
    },

    /**
     * Opens the next pack. The first call also adopts everything already in
     * the basket into Takeaway 1, so switching grouping on never appears to
     * empty the basket or strand items in a pack with no name.
     * @returns {number|null} the new pack number, or null at the ceiling
     */
    addGroup: function () {
      if (state.groups >= MAX_GROUPS) return null;
      if (state.groups === 0) {
        state.groups = 1;
        state.lines.forEach(function (l) { l.group = 1; });
      }
      state.groups += 1;
      state.activeGroup = state.groups;
      write();
      return state.groups;
    },

    /**
     * Removes a pack and everything in it, then closes the numbering gap so
     * the labels stay 1..n with nothing missing in the middle.
     */
    removeGroup: function (group) {
      var g = cleanGroup(group);
      if (g == null) return;
      state.lines = state.lines.filter(function (l) { return l.group !== g; });
      state.lines.forEach(function (l) {
        if (l.group != null && l.group > g) l.group -= 1;
      });
      state.groups = Math.max(0, state.groups - 1);
      if (state.groups <= 1) {
        /* One pack left is not a grouped order — it is an ordinary basket. */
        state.lines.forEach(function (l) { l.group = null; });
        state.groups = 0;
        state.activeGroup = null;
      } else {
        state.activeGroup = Math.min(state.activeGroup || 1, state.groups);
      }
      write();
    },

    /** Move one line into another pack, merging if that pack already has it. */
    moveLine: function (ref, group) {
      var r = parseRef(ref);
      var from = cleanGroup(r.group);
      var to = cleanGroup(group);
      if (from === to) return;
      var line = lineFor(r.menuId, from);
      if (!line) return;
      var target = lineFor(r.menuId, to);
      if (target) {
        target.qty = Math.min(cfg.limits.maxQty, target.qty + line.qty);
        state.lines = state.lines.filter(function (l) { return l !== line; });
      } else {
        line.group = to;
      }
      write();
    },

    /* ---- Derived ------------------------------------------------------ */

    /** Basket lines joined to menu data, ready to render. */
    detailed: function () {
      return state.lines
        .map(function (l) {
          var item = KT.menu.byId(l.menuId);
          if (!item) return null;
          return {
            /* Composite, because the same menuId can appear in two packs and
               a DOM keyed on menuId alone would address the wrong one. */
            key: keyOf(l.menuId, l.group),
            menuId: l.menuId,
            group: l.group == null ? null : l.group,
            groupLabel: cart.groupLabel(l.group == null ? null : l.group),
            item: item,
            qty: l.qty,
            unit: item.price,
            total: item.price * l.qty,
            soldOut: !KT.menu.available(item)
          };
        })
        .filter(Boolean);
    },

    /**
     * detailed(), bucketed by pack for rendering. Returns a single
     * {group:null} bucket when grouping is off, so a caller can use one code
     * path for both shapes.
     * @returns {Array<{group:number|null, label:string, lines:Array}>}
     */
    byGroup: function () {
      var lines = cart.detailed();
      if (state.groups === 0) {
        return lines.length
          ? [{ group: null, label: cart.groupLabel(null), lines: lines }]
          : [];
      }
      var out = [];
      for (var g = 1; g <= state.groups; g += 1) {
        out.push({
          group: g,
          label: cart.groupLabel(g),
          lines: lines.filter(function (l) { return l.group === g; })
        });
      }
      /* Anything still ungrouped (a basket mid-upgrade) keeps its own bucket
         rather than being silently swept into Takeaway 1. */
      var loose = lines.filter(function (l) { return l.group == null; });
      if (loose.length) out.push({ group: null, label: cart.groupLabel(null), lines: loose });
      return out;
    },

    summary: function () {
      var lines = cart.detailed();
      var totals = KT.rules.totals({
        items: lines.map(function (l) {
          return { name: l.item.name, price: l.unit, qty: l.qty };
        }),
        fulfilment: state.fulfilment,
        coupon: KT.rules.coupon(state.couponCode),
        paymentMode: "gateway"
      });
      totals.couponCode = state.couponCode;
      totals.nextCoupon = KT.rules.nextCouponTarget(totals.subtotal);
      totals.hasSoldOut = lines.some(function (l) { return l.soldOut; });
      return totals;
    },

    /** Payload shape expected by `createCheckoutOrder`. */
    toDraft: function (addressId, customer) {
      return {
        items: state.lines.map(function (l) {
          var item = KT.menu.byId(l.menuId);
          return {
            menuId: l.menuId, id: l.menuId, name: item && item.name, qty: l.qty,
            /* Presentation only. create_checkout_order re-validates it and
               it reaches no pricing expression on either side. */
            group: l.group == null ? null : l.group
          };
        }),
        fulfilment: state.fulfilment,
        addressId: state.fulfilment === "delivery" ? addressId || "" : "",
        customer: customer || {},
        coupon: state.couponCode ? { code: state.couponCode } : null,
        notes: state.notes,
        estimatedDeliveryMinutes: KT.rules.ETA_MINUTES[state.fulfilment]
      };
    },

    /* ---- Account scope ------------------------------------------------ */

    /**
     * Re-scope the basket to a signed-in user, merging anything the visitor
     * added while browsing as a guest. Called by the auth service.
     */
    setScope: function (uid) {
      var next = uid || cfg.storage.guestScope;
      if (next === scope) return;

      var incoming = state.lines.slice();
      var incomingGroups = state.groups;
      scope = next;
      state.lines = [];
      state.groups = 0;
      state.activeGroup = null;
      read();

      /* Merge the guest basket into the account basket. Pack identity is part
         of the line, so a guest's Takeaway 2 does not fall into the account's
         Takeaway 2 unless it really is the same item in the same pack. */
      incoming.forEach(function (l) {
        var g = l.group == null ? null : l.group;
        var line = lineFor(l.menuId, g);
        if (line) line.qty = Math.min(cfg.limits.maxQty, line.qty + l.qty);
        else state.lines.push(l);
      });
      state.groups = Math.min(MAX_GROUPS, Math.max(state.groups, incomingGroups));
      var highest = state.lines.reduce(function (n, l) {
        return l.group && l.group > n ? l.group : n;
      }, 0);
      if (highest > state.groups) state.groups = Math.min(MAX_GROUPS, highest);
      state.activeGroup = state.groups > 0 ? 1 : null;
      write();
    },

    /** Drop any basket line whose menu item no longer exists or is sold out. */
    reconcile: function () {
      var before = state.lines.length;
      state.lines = state.lines.filter(function (l) {
        var item = KT.menu.byId(l.menuId);
        return item && KT.menu.available(item);
      });
      if (state.lines.length !== before) write();
      else emit();
      return before - state.lines.length;
    },

    subscribe: function (fn) {
      listeners.push(fn);
      fn(cart.detailed(), cart.summary());
      return function () {
        listeners = listeners.filter(function (f) { return f !== fn; });
      };
    }
  };

  read();
  KT.cart = cart;
})(window.KT || (window.KT = {}));
