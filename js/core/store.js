/* ==========================================================================
   Kandy's Treats — Client-side UI state
   --------------------------------------------------------------------------
   PHASE 1 SCOPE: this is a presentation-layer store only. It exists so the
   cart, badges and drawer behave believably while you click through the
   prototype. There is no server, no auth, no persistence beyond the tab.

   When the backend arrives, replace the read/write internals below and every
   component keeps working — they only ever talk to this interface.
   ========================================================================== */
(function (KT) {
  "use strict";

  var KEY = "kt.cart.v2";
  var listeners = [];

  /* sessionStorage (not localStorage) so the prototype cart survives page
     navigation but never lingers as stale demo data. */
  function read() {
    try {
      return JSON.parse(sessionStorage.getItem(KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  function write(lines) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(lines));
    } catch (e) {
      /* private mode — cart simply lives in memory for this page */
    }
    state = lines;
    emit();
  }

  var state = read();

  function emit() {
    var snap = cart.summary();
    listeners.forEach(function (fn) {
      fn(state, snap);
    });
  }

  /* A cart line is unique by item + the exact add-on selection. */
  function lineKey(itemId, addons) {
    var flat = Object.keys(addons || {})
      .sort()
      .map(function (g) {
        return g + ":" + [].concat(addons[g]).sort().join("+");
      })
      .join("|");
    return itemId + (flat ? "__" + flat : "");
  }

  function addonPrice(item, addons) {
    var sum = 0;
    (item.addons || []).forEach(function (group) {
      var chosen = [].concat((addons || {})[group.id] || []);
      group.options.forEach(function (opt) {
        if (chosen.indexOf(opt.id) > -1) sum += opt.price;
      });
    });
    return sum;
  }

  function addonLabels(item, addons) {
    var out = [];
    (item.addons || []).forEach(function (group) {
      var chosen = [].concat((addons || {})[group.id] || []);
      group.options.forEach(function (opt) {
        if (chosen.indexOf(opt.id) > -1 && opt.id !== "none") out.push(opt.name);
      });
    });
    return out;
  }

  var DELIVERY_FEE = 1500;
  var FREE_DELIVERY_FROM = 20000;
  var SERVICE_RATE = 0.025;

  var cart = {
    DELIVERY_FEE: DELIVERY_FEE,
    FREE_DELIVERY_FROM: FREE_DELIVERY_FROM,

    lines: function () {
      return state.slice();
    },

    count: function () {
      return state.reduce(function (n, l) {
        return n + l.qty;
      }, 0);
    },

    add: function (itemId, qty, addons) {
      var item = KT.menu.byId(itemId);
      if (!item) return null;
      qty = qty || 1;
      addons = addons || KT.menu.defaultAddons(item);

      var key = lineKey(itemId, addons);
      var next = state.slice();
      var found = next.filter(function (l) {
        return l.key === key;
      })[0];

      if (found) {
        found.qty += qty;
      } else {
        next.push({
          key: key,
          itemId: itemId,
          qty: qty,
          addons: addons,
          unit: item.price + addonPrice(item, addons),
          extras: addonLabels(item, addons)
        });
      }
      write(next);
      return key;
    },

    setQty: function (key, qty) {
      var next = state
        .map(function (l) {
          return l.key === key ? Object.assign({}, l, { qty: qty }) : l;
        })
        .filter(function (l) {
          return l.qty > 0;
        });
      write(next);
    },

    bump: function (key, delta) {
      var line = state.filter(function (l) {
        return l.key === key;
      })[0];
      if (line) cart.setQty(key, line.qty + delta);
    },

    remove: function (key) {
      write(
        state.filter(function (l) {
          return l.key !== key;
        })
      );
    },

    clear: function () {
      write([]);
    },

    /** Hydrated lines: cart data joined to menu data, ready to render. */
    detailed: function () {
      return state
        .map(function (l) {
          var item = KT.menu.byId(l.itemId);
          if (!item) return null;
          return {
            key: l.key,
            item: item,
            qty: l.qty,
            unit: l.unit,
            total: l.unit * l.qty,
            extras: l.extras || []
          };
        })
        .filter(Boolean);
    },

    summary: function () {
      var lines = cart.detailed();
      var subtotal = lines.reduce(function (n, l) {
        return n + l.total;
      }, 0);
      var delivery =
        subtotal === 0 ? 0 : subtotal >= FREE_DELIVERY_FROM ? 0 : DELIVERY_FEE;
      var service = Math.round(subtotal * SERVICE_RATE);
      /* Longest prep time in the basket drives the estimate. */
      var prep = lines.reduce(function (m, l) {
        return Math.max(m, l.item.prep || 0);
      }, 0);
      return {
        count: cart.count(),
        subtotal: subtotal,
        delivery: delivery,
        service: subtotal === 0 ? 0 : service,
        total: subtotal + delivery + (subtotal === 0 ? 0 : service),
        freeDeliveryGap: Math.max(0, FREE_DELIVERY_FROM - subtotal),
        eta: prep ? prep + 15 : 0
      };
    },

    subscribe: function (fn) {
      listeners.push(fn);
      fn(state, cart.summary());
      return function () {
        listeners = listeners.filter(function (f) {
          return f !== fn;
        });
      };
    }
  };

  KT.cart = cart;
})(window.KT || (window.KT = {}));
