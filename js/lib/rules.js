/* ==========================================================================
   Kandy's Treats — Business rules
   --------------------------------------------------------------------------
   A faithful client-side mirror of the pricing and validation logic in
   functions/index.js, so the customer sees the same totals the server will
   charge. The SERVER IS AUTHORITATIVE: `createCheckoutOrder` recomputes every
   line from `menus/{id}`, re-derives fees and coupons, and rejects anything
   that does not add up. Nothing here can be used to underpay.

   Every constant below carries the line it mirrors.
   ========================================================================== */
(function (KT) {
  "use strict";

  /* functions/index.js: DELIVERY_FEE = 500 — flat, Ado-Ekiti/Iworoko only. */
  var DELIVERY_FEE = 500;

  /* functions/index.js: PROCESSING_FEE_RATE = 0.02 — gateway payments only.
     Wallet payments carry no processing fee. */
  var PROCESSING_FEE_RATE = 0.02;

  /* functions/index.js: ORDER_STATUSES */
  var ORDER_STATUSES = ["New", "Preparing", "Out", "Completed"];

  var STATUS_META = {
    New: { label: "Order received", blurb: "We have your order and the kitchen has been notified.", icon: "receipt" },
    Preparing: { label: "In the kitchen", blurb: "Your food is being cooked to order right now.", icon: "flame" },
    Out: { label: "Out for delivery", blurb: "A rider has picked up your order.", icon: "bike" },
    Completed: { label: "Completed", blurb: "Delivered. Enjoy your food.", icon: "check" }
  };

  /* functions/index.js: COUPONS */
  var COUPONS = {
    WELCOME5: { code: "WELCOME5", label: "Welcome discount", type: "percent", value: 5, minSubtotal: 1000 },
    KANDY10: { code: "KANDY10", label: "Kandys customer reward", type: "percent", value: 10, minSubtotal: 5000 }
  };

  var FULFILMENTS = ["delivery", "pickup"];

  /* Estimated minutes, mirroring the draft defaults in V1's app.js. */
  /* Customer-facing preparation estimates. ETA_MINUTES is the single number
     stored on an order (estimatedDeliveryMinutes); ETA_TEXT is what the
     storefront shows, because a range reads more honestly than a point value. */
  var ETA_MINUTES = { delivery: 25, pickup: 10 };
  var ETA_TEXT = { delivery: "20–25 min", pickup: "~10 min" };

  var rules = {
    DELIVERY_FEE: DELIVERY_FEE,
    PROCESSING_FEE_RATE: PROCESSING_FEE_RATE,
    ORDER_STATUSES: ORDER_STATUSES,
    STATUS_META: STATUS_META,
    COUPONS: COUPONS,
    FULFILMENTS: FULFILMENTS,
    ETA_MINUTES: ETA_MINUTES,
    ETA_TEXT: ETA_TEXT,

    /* ---- Formatting ------------------------------------------------- */

    formatPrice: function (value) {
      return "₦" + Number(value || 0).toLocaleString("en-NG");
    },

    /* functions/index.js: normalizePhone */
    normalizePhone: function (phone) {
      var digits = String(phone || "").replace(/[^\d]/g, "");
      if (digits.length === 11 && digits.charAt(0) === "0") return "234" + digits.slice(1);
      if (digits.length === 10 && digits.charAt(0) === "7") return "234" + digits;
      return digits;
    },

    /** Human-readable form of a normalised 234XXXXXXXXXX number. */
    displayPhone: function (phone) {
      var d = rules.normalizePhone(phone);
      if (d.length === 13 && d.indexOf("234") === 0) {
        return "+234 " + d.slice(3, 6) + " " + d.slice(6, 9) + " " + d.slice(9);
      }
      return phone || "";
    },

    isValidPhone: function (phone) {
      var d = rules.normalizePhone(phone);
      return d.length === 13 && d.indexOf("234") === 0;
    },

    /* functions/index.js: cleanString */
    cleanString: function (value, max) {
      return String(value || "").replace(/\s+/g, " ").trim().slice(0, max || 160);
    },

    /* ---- Fees ------------------------------------------------------- */

    /**
     * Card-processing fee — currently DISABLED.
     *
     * create_checkout_order() prices every order with processing_fee = 0: at
     * order time the server cannot know whether the customer will pay by card
     * or from their wallet, so it charges neither. The basket used to add 2%
     * anyway, which made it display a total (₦3,978) the customer was never
     * charged (₦3,900) — the same basket, two numbers.
     *
     * The basket must show what the server will actually charge, so this
     * returns 0 and the "Card processing" line disappears on its own (every
     * render site is already guarded on a truthy fee).
     *
     * PROCESSING_FEE_RATE is kept so re-enabling is a one-line change, but it
     * must be turned on in create_checkout_order FIRST — the server total is
     * the authority, and the basket only ever mirrors it.
     */
    processingFee: function () {
      return 0;
    },

    /* functions/index.js: calculateTakeawayFee
       Packaging is charged only when the order contains real food (not just
       drinks). Ofada, or rice AND beans together, needs the bigger pack. */
    takeawayFee: function (items) {
      var hasFood = false;
      var hasRice = false;
      var hasBeans = false;
      var hasOfada = false;

      (items || []).forEach(function (item) {
        var name = String(item.name || "").toLowerCase();
        if (/(coke|fanta|pepsi|soda|juice|chivita|hollandia|yogurt|water)/.test(name)) return;
        if (/(rice|beans|ofada|amala|swallow|semo|eba|spaghetti|pepper soup|pounded yam|ewa agoyin)/.test(name)) {
          hasFood = true;
        }
        if (name.indexOf("rice") > -1) hasRice = true;
        if (name.indexOf("beans") > -1) hasBeans = true;
        if (name.indexOf("ofada") > -1) hasOfada = true;
      });

      if (!hasFood) return 0;
      if (hasOfada || (hasRice && hasBeans)) return 300;
      return 200;
    },

    deliveryFee: function (fulfilment, itemCount) {
      return fulfilment === "delivery" && itemCount > 0 ? DELIVERY_FEE : 0;
    },

    /* ---- Coupons ---------------------------------------------------- */

    coupon: function (code) {
      return COUPONS[rules.cleanString(code, 30).toUpperCase()] || null;
    },

    /* functions/index.js: calculateCouponDiscount */
    couponDiscount: function (coupon, subtotal) {
      if (!coupon || subtotal < (coupon.minSubtotal || 0)) return 0;
      if (coupon.type === "percent") return Math.round((subtotal * coupon.value) / 100);
      if (coupon.type === "fixed") return Math.min(subtotal, Number(coupon.value || 0));
      return 0;
    },

    /**
     * The best coupon this basket does NOT yet qualify for, and how much more
     * is needed. Drives the progress meter in the cart.
     */
    nextCouponTarget: function (subtotal) {
      var candidates = Object.keys(COUPONS)
        .map(function (k) { return COUPONS[k]; })
        .filter(function (c) { return subtotal < c.minSubtotal; })
        .sort(function (a, b) { return a.minSubtotal - b.minSubtotal; });
      if (!candidates.length) return null;
      var next = candidates[0];
      return {
        coupon: next,
        gap: next.minSubtotal - subtotal,
        progress: Math.min(100, Math.round((subtotal / next.minSubtotal) * 100))
      };
    },

    /** The best coupon this basket already qualifies for. */
    bestAvailableCoupon: function (subtotal) {
      var eligible = Object.keys(COUPONS)
        .map(function (k) { return COUPONS[k]; })
        .filter(function (c) { return subtotal >= c.minSubtotal; })
        .sort(function (a, b) {
          return rules.couponDiscount(b, subtotal) - rules.couponDiscount(a, subtotal);
        });
      return eligible[0] || null;
    },

    /* ---- Totals ----------------------------------------------------- */

    /**
     * The single source of truth for basket totals in the UI.
     * Mirrors buildServerOrder() in functions/index.js.
     *
     * @param {{items:Array, fulfilment?:string, coupon?:object|null,
     *          paymentMode?:string}} input
     */
    totals: function (input) {
      var items = input.items || [];
      var fulfilment = input.fulfilment === "pickup" ? "pickup" : "delivery";
      var paymentMode = input.paymentMode === "wallet" ? "wallet" : "gateway";

      var subtotal = items.reduce(function (sum, i) {
        return sum + Number(i.price || 0) * Number(i.qty || 0);
      }, 0);

      var takeawayFee = rules.takeawayFee(items);
      var deliveryFee = rules.deliveryFee(fulfilment, items.length);
      var discount = rules.couponDiscount(input.coupon, subtotal);
      var netAmount = subtotal + takeawayFee + deliveryFee - discount;
      /* Always 0 today — see rules.processingFee. Kept in the shape so the
         server remains the single source of truth for what is charged. */
      var processingFee = rules.processingFee(netAmount, paymentMode);

      return {
        count: items.reduce(function (n, i) { return n + Number(i.qty || 0); }, 0),
        subtotal: subtotal,
        takeawayFee: takeawayFee,
        deliveryFee: deliveryFee,
        discount: discount,
        netAmount: netAmount,
        processingFee: processingFee,
        total: netAmount + processingFee,
        fulfilment: fulfilment,
        paymentMode: paymentMode,
        eta: items.length ? ETA_MINUTES[fulfilment] : 0
      };
    },

    /* ---- Orders ----------------------------------------------------- */

    /** Position of a status in the New → Preparing → Out → Completed flow. */
    statusIndex: function (status) {
      var i = ORDER_STATUSES.indexOf(status);
      return i === -1 ? 0 : i;
    },

    /** Timeline steps for an order, from its status and statusHistory. */
    timeline: function (order) {
      var history = Array.isArray(order && order.statusHistory) ? order.statusHistory : [];
      var current = rules.statusIndex(order && order.status);
      var cancelled = String((order && order.paymentStatus) || "") === "cancelled";

      return ORDER_STATUSES.map(function (status, index) {
        var entry = history.filter(function (h) { return h.status === status; })[0];
        var meta = STATUS_META[status];
        return {
          key: status,
          label: meta.label,
          blurb: meta.blurb,
          icon: meta.icon,
          time: entry && entry.atMs ? new Date(entry.atMs) : null,
          done: index <= current && !cancelled,
          current: index === current && !cancelled
        };
      });
    },

    /** V1 order ids look like KD-1737052800000-482. */
    isOrderId: function (value) {
      return /^KD-(PENDING-)?\d+-\d+$/.test(String(value || ""));
    },

    /* functions/index.js: cleanAddressPayload */
    validateAddress: function (payload) {
      var errors = {};
      var address = rules.cleanString(payload && payload.address, 500);
      if (address.length < 8) {
        errors.address = "Enter your full address — street, area and a landmark.";
      }
      if (!rules.cleanString(payload && payload.recipientName, 100)) {
        errors.recipientName = "Who should the rider ask for?";
      }
      if (!rules.isValidPhone(payload && payload.phone)) {
        errors.phone = "Enter a valid Nigerian phone number.";
      }
      return { valid: !Object.keys(errors).length, errors: errors };
    }
  };

  KT.rules = rules;
})(window.KT || (window.KT = {}));
