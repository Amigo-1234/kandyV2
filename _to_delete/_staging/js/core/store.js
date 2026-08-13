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
    lines: [],                 // [{ menuId, qty }]
    fulfilment: "delivery",    // delivery | pickup
    couponCode: "",
    notes: ""
  };

  /* ---- Persistence ---------------------------------------------------- */

  function key(base) {
    return base + "_" + scope;
  }

  function read() {
    try {
      var raw = localStorage.getItem(key(cfg.storage.cart));
      var parsed = raw ? JSON.parse(raw) : null;
      if (!parsed) return;
      if (Array.isArray(parsed)) {
        state.lines = parsed;
      } else {
        state.lines = Array.isArray(parsed.lines) ? parsed.lines : [];
        state.fulfilment = parsed.fulfilment === "pickup" ? "pickup" : "delivery";
        state.couponCode = parsed.couponCode || "";
        state.notes = parsed.notes || "";
      }
    } catch (e) {
      state.lines = [];
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

  function lineFor(menuId) {
    return state.lines.filter(function (l) { return l.menuId === menuId; })[0];
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

    qtyOf: function (menuId) {
      var line = lineFor(menuId);
      return line ? line.qty : 0;
    },

    /* ---- Writing ------------------------------------------------------ */

    add: function (menuId, qty) {
      var item = KT.menu.byId(menuId);
      if (!item || !KT.menu.available(item)) return false;
      qty = Math.max(1, Math.trunc(Number(qty) || 1));

      var line = lineFor(menuId);
      if (line) {
        line.qty = Math.min(cfg.limits.maxQty, line.qty + qty);
      } else {
        if (state.lines.length >= cfg.limits.maxItems) return false;
        state.lines.push({ menuId: menuId, qty: Math.min(cfg.limits.maxQty, qty) });
      }
      write();
      return true;
    },

    setQty: function (menuId, qty) {
      qty = Math.trunc(Number(qty) || 0);
      if (qty <= 0) return cart.remove(menuId);
      var line = lineFor(menuId);
      if (line) line.qty = Math.min(cfg.limits.maxQty, qty);
      write();
    },

    bump: function (menuId, delta) {
      var line = lineFor(menuId);
      if (!line) {
        if (delta > 0) cart.add(menuId, delta);
        return;
      }
      cart.setQty(menuId, line.qty + delta);
    },

    remove: function (menuId) {
      state.lines = state.lines.filter(function (l) { return l.menuId !== menuId; });
      write();
    },

    clear: function () {
      state.lines = [];
      state.couponCode = "";
      state.notes = "";
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
            key: l.menuId,
            menuId: l.menuId,
            item: item,
            qty: l.qty,
            unit: item.price,
            total: item.price * l.qty,
            soldOut: !KT.menu.available(item)
          };
        })
        .filter(Boolean);
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
          return { menuId: l.menuId, id: l.menuId, name: item && item.name, qty: l.qty };
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
      scope = next;
      state.lines = [];
      read();

      /* Merge the guest basket into the account basket. */
      incoming.forEach(function (l) {
        var line = lineFor(l.menuId);
        if (line) line.qty = Math.min(cfg.limits.maxQty, line.qty + l.qty);
        else state.lines.push(l);
      });
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
