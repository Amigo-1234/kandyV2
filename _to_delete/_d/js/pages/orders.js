/* ==========================================================================
   Kandy's Treats — Order history & order detail
   Live Firestore orders. Statuses follow V1's flow: New → Preparing → Out →
   Completed, read from `statusHistory`. The order-detail page also handles
   the return leg from Paystack/Flutterwave and offers wallet payment.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.pages = KT.pages || {};

  var TABS = [
    ["all", "All orders"],
    ["open", "In progress"],
    ["Completed", "Completed"]
  ];

  function when(date) {
    if (!date) return "";
    return date.toLocaleString("en-NG", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
    });
  }

  function statusClass(order) {
    if (order.paymentStatus === "cancelled") return "cancelled";
    if (order.status === "Completed") return "delivered";
    if (order.status === "Out") return "on-the-way";
    return "on-the-way";
  }

  function thumbs(order) {
    var shown = (order.items || []).slice(0, 3);
    var extra = (order.items || []).length - shown.length;
    return '<div class="orderthumbs">' +
      shown.map(function (l) {
        var item = KT.menu.byId(l.menuId || l.id);
        return '<span class="ring"><img data-food alt="" src="' + KT.images.src(item || {}) + '"></span>';
      }).join("") +
      (extra > 0 ? '<span class="orderthumbs__more">+' + extra + "</span>" : "") +
      "</div>";
  }

  function names(order) {
    return (order.items || []).map(function (l) {
      return (l.qty > 1 ? l.qty + "× " : "") + (l.name || "Item");
    }).join(", ");
  }

  function card(order) {
    var paid = order.paid;
    return (
      '<article class="ordercard">' +
        '<div class="ordercard__top">' +
          '<div><p class="ordercard__id">' + order.id + "</p>" +
            '<p class="ordercard__when">' + when(order.createdAt) +
              (paid ? "" : " · payment pending") + "</p></div>" +
          '<span class="status status--' + statusClass(order) + '">' + order.statusLabel + "</span>" +
        "</div>" +
        '<div class="ordercard__body">' +
          thumbs(order) +
          '<div class="ordercard__sum"><strong>' + names(order) + "</strong>" +
            "<span>" + KT.plural(order.itemCount, "item") + " · " +
            (order.fulfilment === "pickup" ? "Pickup" : "Delivery") + "</span></div>" +
          '<div class="ordercard__right">' +
            '<div class="ordercard__total"><span class="price">' + KT.naira(order.total) +
              "</span><em>total</em></div>" +
            '<a class="btn btn--ghost btn--sm" href="' +
              KT.url("pages/order-detail.html?id=" + encodeURIComponent(order.id)) + '">' +
              (paid ? "View details" : "Pay now") + "</a>" +
            (paid ? '<button class="btn btn--soft btn--sm" type="button" data-reorder="' +
              order.id + '">Reorder</button>' : "") +
          "</div>" +
        "</div>" +
      "</article>"
    );
  }

  /* ---- History --------------------------------------------------------- */

  KT.pages.orders = function () {
    var active = "all";
    var orders = [];
    var tabsHost = KT.qs("[data-order-tabs]");
    var listHost = KT.qs("[data-order-list]");

    if (KT.pages.accountNav) KT.mount("[data-account-nav]", KT.pages.accountNav("orders"));

    tabsHost.innerHTML = TABS.map(function (t) {
      return '<button class="chip' + (t[0] === "all" ? " is-active" : "") +
        '" type="button" data-otab="' + t[0] + '">' + t[1] + "</button>";
    }).join("");

    function paint() {
      if (!KT.auth || !KT.auth.isSignedIn()) {
        listHost.innerHTML =
          '<div class="empty"><div class="empty__art">' + KT.icon("receipt", 38) + "</div>" +
          "<h3>Sign in to see your orders</h3>" +
          "<p>Every order you place is saved to your account with its live status.</p>" +
          '<a class="btn btn--primary" href="' + KT.url("pages/login.html?next=orders") + '">Sign in</a></div>';
        return;
      }

      var list = orders.filter(function (o) {
        if (active === "all") return true;
        if (active === "open") return o.status !== "Completed" && o.paymentStatus !== "cancelled";
        return o.status === active;
      });

      listHost.innerHTML = list.length
        ? list.map(card).join("")
        : '<div class="empty"><div class="empty__art">' + KT.icon("receipt", 38) +
          "</div><h3>Nothing here yet</h3><p>Orders with this status will show up here.</p>" +
          '<a class="btn btn--soft" href="' + KT.url("pages/menu.html") + '">Browse the menu</a></div>';
      KT.images.bindAll(listHost);
    }

    async function load() {
      if (!KT.services || !KT.auth.isSignedIn()) return paint();
      try {
        orders = await KT.services.orders.list({ limit: 30 });
      } catch (e) {
        orders = [];
      }
      paint();
    }

    tabsHost.addEventListener("click", function (e) {
      var b = e.target.closest("[data-otab]");
      if (!b) return;
      active = b.getAttribute("data-otab");
      KT.qsa("[data-otab]", tabsHost).forEach(function (x) {
        x.classList.toggle("is-active", x === b);
      });
      paint();
    });

    document.addEventListener("click", function (e) {
      var b = e.target.closest("[data-reorder]");
      if (!b) return;
      var order = orders.filter(function (o) { return o.id === b.getAttribute("data-reorder"); })[0];
      if (!order) return;
      var result = KT.services.orders.reorder(order);
      KT.toast(
        result.added
          ? "Added " + KT.plural(result.added, "item") + " to your basket" +
            (result.skipped ? " · " + result.skipped + " no longer available" : "")
          : "Those items are no longer on the menu.",
        result.added ? "success" : "info",
        result.added ? { action: "View basket", onAction: function () { KT.drawer.open(); } } : {}
      );
    });

    paint();
    document.addEventListener("kt:auth", load);
    document.addEventListener("kt:services", load);
    load();
  };

  /* ---- Detail ---------------------------------------------------------- */

  KT.pages["order-detail"] = function () {
    var orderId = KT.param("id");
    var order = null;
    var host = KT.qs("[data-order-detail]");

    function paymentPanel() {
      if (order.paid) {
        return '<div class="deliverycard" style="border-color:var(--mint);background:var(--mint-50)">' +
          '<span class="deliverycard__icon" style="background:#fff;color:var(--mint)">' +
          KT.icon("check", 19) + "</span><div><strong>Payment confirmed</strong>" +
          "<p>Paid with " + (order.paymentProvider || "card") + ". Reference " +
          (order.paymentRef || "—") + "</p></div></div>";
      }
      if (order.paymentStatus === "cancelled") {
        return '<div class="phasenote">' + KT.icon("close", 16) +
          "<span>This payment was cancelled. Start it again below or reorder the items.</span></div>";
      }
      return (
        '<div class="cartpanel" style="padding:0;border:0">' +
          '<p class="field__label">Pay ' + KT.naira(order.total) + " to send this to the kitchen</p>" +
          '<div style="display:grid;gap:10px;margin-top:10px" data-pay-buttons>' +
            KT.services.payments.PROVIDERS.map(function (p) {
              return '<button class="btn btn--primary btn--block" type="button" data-pay="' + p.id + '">' +
                "Pay with " + p.name + "<span style=\"opacity:.8;font-weight:600\">" + p.blurb + "</span></button>";
            }).join("") +
            '<button class="btn btn--ghost btn--block" type="button" data-pay-wallet>' +
              KT.icon("wallet", 17) + "Pay from my Kandy's wallet</button>" +
          "</div>" +
          '<div class="phasenote" style="margin-top:12px">' + KT.icon("lock", 16) +
            "<span>You pay on the gateway's own secure page. Card details never reach this site, " +
            "and the order is only marked paid after our server verifies the transaction.</span></div>" +
        "</div>"
      );
    }

    function render() {
      if (!order) return;
      var steps = KT.rules.timeline(order);
      var cancelled = order.paymentStatus === "cancelled";

      KT.mount(host,
        '<nav class="crumbs" aria-label="Breadcrumb">' +
          '<a href="' + KT.url("index.html") + '">Home</a>' + KT.icon("chevronRight", 13) +
          '<a href="' + KT.url("pages/orders.html") + '">Orders</a>' +
          KT.icon("chevronRight", 13) + "<strong>" + order.id + "</strong></nav>" +

        '<div class="orderdetail__grid">' +
          "<div>" +
            '<div class="panel">' +
              '<div class="panel__head"><div><h2>' +
                (order.paid ? "Tracking your order" : "Order " + order.id) + "</h2>" +
                "<p>" + when(order.createdAt) + " · " +
                (order.fulfilment === "pickup" ? "Pickup" : "Delivery") + "</p></div>" +
                '<span class="status status--' + statusClass(order) + '">' +
                  (cancelled ? "Cancelled" : order.statusLabel) + "</span></div>" +

              (order.paid && !cancelled
                ? '<div class="track">' + steps.map(function (s) {
                    return '<div class="track__step' + (s.done ? " is-done" : "") +
                      (s.current ? " is-current" : "") + '">' +
                      '<span class="track__dot">' + KT.icon(s.done ? "check" : "dot", s.done ? 15 : 10) +
                      "</span>" +
                      '<div class="track__text"><strong>' + s.label + "</strong>" +
                      "<span>" + (s.time ? when(s.time) : s.blurb) + "</span></div></div>";
                  }).join("") + "</div>"
                : "") +

              paymentPanel() +
            "</div>" +

            '<div class="panel">' +
              '<div class="panel__head"><h2>What you ordered</h2></div>' +
              '<div class="orderitems">' +
                (order.items || []).map(function (l) {
                  var item = KT.menu.byId(l.menuId || l.id);
                  return '<div class="orderitem">' +
                    '<span class="ring"><img data-food alt="" src="' + KT.images.src(item || {}) + '"></span>' +
                    '<div class="orderitem__text"><strong>' + (l.name || "Item") + "</strong>" +
                    "<span>" + KT.naira(l.price) + " each</span></div>" +
                    '<span class="orderitem__qty">×' + l.qty + "</span>" +
                    '<span class="price">' + KT.naira(l.lineTotal || l.price * l.qty) + "</span></div>";
                }).join("") +
              "</div>" +
              (order.notes ? '<p class="field__hint" style="margin-top:14px">Note: ' + order.notes + "</p>" : "") +
            "</div>" +
          "</div>" +

          "<aside>" +
            '<div class="panel">' +
              '<div class="panel__head"><h2>Summary</h2></div>' +
              '<dl class="csum">' +
                "<div><dt>Subtotal</dt><dd>" + KT.naira(order.subtotal) + "</dd></div>" +
                (order.takeawayFee ? "<div><dt>Packaging</dt><dd>" + KT.naira(order.takeawayFee) + "</dd></div>" : "") +
                "<div><dt>" + (order.fulfilment === "pickup" ? "Pickup" : "Delivery") + "</dt><dd>" +
                  (order.deliveryFee ? KT.naira(order.deliveryFee) : "₦0") + "</dd></div>" +
                (order.discount ? "<div><dt>Discount</dt><dd>−" + KT.naira(order.discount) + "</dd></div>" : "") +
                (order.processingFee ? "<div><dt>Card processing</dt><dd>" + KT.naira(order.processingFee) + "</dd></div>" : "") +
                '<div class="csum__total"><dt>Total</dt><dd class="price price--lg">' +
                  KT.naira(order.total) + "</dd></div>" +
              "</dl>" +
              (order.addressSnapshot
                ? '<div class="deliverycard" style="margin-top:16px">' +
                  '<span class="deliverycard__icon">' + KT.icon("pin", 19) + "</span>" +
                  "<div><strong>Delivering to</strong><p>" + order.addressSnapshot.address + "</p>" +
                  (order.addressSnapshot.notes ? "<small>" + order.addressSnapshot.notes + "</small>" : "") +
                  "</div></div>"
                : "") +
              '<div style="display:grid;gap:10px;margin-top:16px">' +
                (order.paid ? '<button class="btn btn--primary btn--block" type="button" data-reorder-detail>' +
                  "Reorder these items</button>" : "") +
                '<a class="btn btn--ghost btn--block" href="' + KT.url("pages/menu.html") + '">Order something else</a>' +
              "</div>" +
            "</div>" +
          "</aside>" +
        "</div>");

      KT.images.bindAll(document);
    }

    function signedOut() {
      KT.mount(host, '<div class="panel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("lock", 38) + "</div>" +
        "<h3>Sign in to view this order</h3>" +
        '<a class="btn btn--primary" href="' + KT.url("pages/login.html?next=orders") + '">Sign in</a></div></div>');
    }

    async function handleGatewayReturn() {
      var ret = KT.services.payments.readReturn();
      if (!ret || !ret.orderId) return;

      if (ret.status === "cancelled" || ret.status === "canceled" || ret.status === "failed") {
        await KT.services.payments.recordFailure(ret);
        KT.toast("Payment was not completed.", "info");
        return;
      }
      KT.toast("Confirming your payment…", "info");
      try {
        await KT.services.payments.verify(ret);
        KT.toast("Payment confirmed — the kitchen has your order.", "success", { duration: 5000 });
      } catch (error) {
        KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
      }
    }

    async function load() {
      if (!KT.services || !KT.auth.isSignedIn()) return signedOut();
      if (!orderId) return signedOut();

      await handleGatewayReturn();
      try {
        order = await KT.services.orders.get(orderId);
      } catch (e) {
        order = null;
      }
      if (!order) {
        KT.mount(host, '<div class="panel"><div class="empty">' +
          '<div class="empty__art">' + KT.icon("receipt", 38) + "</div>" +
          "<h3>We could not find that order</h3>" +
          '<a class="btn btn--soft" href="' + KT.url("pages/orders.html") + '">Back to your orders</a></div></div>');
        return;
      }
      render();

      /* Arriving straight from the basket — put payment in view. */
      if (KT.param("pay") && !order.paid) {
        var target = KT.qs("[data-pay-buttons]");
        if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
      }

      KT.services.orders.watch(orderId, function (fresh) { order = fresh; render(); });
    }

    document.addEventListener("click", async function (e) {
      var pay = e.target.closest("[data-pay]");
      if (pay) {
        pay.disabled = true;
        pay.textContent = "Opening " + pay.getAttribute("data-pay") + "…";
        try {
          await KT.services.payments.start(order.id, pay.getAttribute("data-pay"));
        } catch (error) {
          pay.disabled = false;
          render();
          KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
        }
      }

      if (e.target.closest("[data-pay-wallet]")) {
        try {
          await KT.services.wallet.payOrder(order.id);
          KT.toast("Paid from your wallet.", "success");
          order = await KT.services.orders.get(orderId);
          render();
        } catch (error) {
          KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
        }
      }

      if (e.target.closest("[data-reorder-detail]") && order) {
        var result = KT.services.orders.reorder(order);
        KT.toast("Added " + KT.plural(result.added, "item") + " to your basket", "success", {
          action: "View basket", onAction: function () { KT.drawer.open(); }
        });
      }
    });

    signedOut();
    document.addEventListener("kt:auth", load);
    document.addEventListener("kt:services", load);
  };
})(window.KT || (window.KT = {}));
