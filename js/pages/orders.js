/* ==========================================================================
   Kandy's Treats — Order history & order detail (UI ONLY)
   Reads the mock data in js/data/orders.js.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.pages = KT.pages || {};

  var TABS = [
    ["all", "All orders"],
    ["on-the-way", "In progress"],
    ["delivered", "Delivered"],
    ["cancelled", "Cancelled"]
  ];

  function thumbs(order) {
    var shown = order.lines.slice(0, 3);
    var extra = order.lines.length - shown.length;
    return (
      '<div class="orderthumbs">' +
      shown
        .map(function (l) {
          var item = KT.menu.byId(l.itemId);
          return (
            '<span class="ring"><img data-food alt="" src="' +
            KT.images.src(item ? item.image : "", "thumb") + '"></span>'
          );
        })
        .join("") +
      (extra > 0 ? '<span class="orderthumbs__more">+' + extra + "</span>" : "") +
      "</div>"
    );
  }

  function names(order) {
    return order.lines
      .map(function (l) {
        var item = KT.menu.byId(l.itemId);
        return (l.qty > 1 ? l.qty + "× " : "") + (item ? item.name : "Item");
      })
      .join(", ");
  }

  function card(order) {
    return (
      '<article class="ordercard">' +
        '<div class="ordercard__top">' +
          "<div><p class=\"ordercard__id\">" + order.id + "</p>" +
            '<p class="ordercard__when">' + order.placed + "</p></div>" +
          '<span class="status status--' + order.status + '">' + order.statusLabel + "</span>" +
        "</div>" +
        '<div class="ordercard__body">' +
          thumbs(order) +
          '<div class="ordercard__sum"><strong>' + names(order) + "</strong>" +
            "<span>" + KT.plural(KT.account.itemCount(order), "item") + " · " + order.eta + "</span></div>" +
          '<div class="ordercard__right">' +
            '<div class="ordercard__total"><span class="price">' +
              KT.naira(KT.account.orderTotal(order)) + "</span><em>total</em></div>" +
            '<a class="btn btn--ghost btn--sm" href="' +
              KT.url("pages/order-detail.html?id=" + order.id) + '">' +
              (order.status === "on-the-way" ? "Track order" : "View details") + "</a>" +
            (order.status === "delivered"
              ? '<button class="btn btn--soft btn--sm" type="button" data-reorder="' + order.id + '">Reorder</button>'
              : "") +
          "</div>" +
        "</div>" +
      "</article>"
    );
  }

  /* ---- Order history --------------------------------------------------- */

  KT.pages.orders = function () {
    if (KT.pages.accountNav) KT.mount("[data-account-nav]", KT.pages.accountNav("orders"));

    var active = "all";
    var tabsHost = KT.qs("[data-order-tabs]");
    var listHost = KT.qs("[data-order-list]");

    tabsHost.innerHTML = TABS.map(function (t) {
      return (
        '<button class="chip' + (t[0] === "all" ? " is-active" : "") +
        '" type="button" data-otab="' + t[0] + '">' + t[1] + "</button>"
      );
    }).join("");

    function paint() {
      var list = KT.account.orders.filter(function (o) {
        return active === "all" || o.status === active;
      });

      listHost.innerHTML = list.length
        ? list.map(card).join("")
        : '<div class="empty"><div class="empty__art">' + KT.icon("receipt", 38) +
          "</div><h3>Nothing here yet</h3><p>Orders with this status will show up here.</p></div>";

      KT.images.bindAll(listHost);
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
      var order = KT.account.order(b.getAttribute("data-reorder"));
      if (!order) return;
      order.lines.forEach(function (l) {
        KT.cart.add(l.itemId, l.qty);
      });
      KT.toast("Added " + KT.plural(KT.account.itemCount(order), "item") + " to your basket", "success", {
        action: "View basket",
        onAction: function () {
          KT.drawer.open();
        }
      });
    });

    paint();
  };

  /* ---- Order detail ---------------------------------------------------- */

  KT.pages["order-detail"] = function () {
    var order = KT.account.order(KT.param("id")) || KT.account.orders[0];
    document.title = "Order " + order.id + " — Kandy's Treats";

    var sub = order.lines.reduce(function (n, l) {
      var item = KT.menu.byId(l.itemId);
      return n + (item ? item.price * l.qty : 0);
    }, 0);
    var delivery = sub >= 20000 ? 0 : 1500;
    var service = Math.round(sub * 0.025);

    KT.mount(
      "[data-order-detail]",
      '<nav class="crumbs" aria-label="Breadcrumb">' +
        '<a href="' + KT.url("index.html") + '">Home</a>' + KT.icon("chevronRight", 13) +
        '<a href="' + KT.url("pages/orders.html") + '">Orders</a>' +
        KT.icon("chevronRight", 13) + "<strong>" + order.id + "</strong></nav>" +

      '<div class="orderdetail__grid">' +
        '<div>' +
          '<div class="panel">' +
            '<div class="panel__head">' +
              "<div><h2>" + (order.status === "on-the-way" ? "Tracking your order" : "Order " + order.id) + "</h2>" +
                "<p>" + order.placed + " · " + order.eta + "</p></div>" +
              '<span class="status status--' + order.status + '">' + order.statusLabel + "</span>" +
            "</div>" +

            (order.timeline
              ? '<div class="track">' +
                  order.timeline
                    .map(function (s) {
                      return (
                        '<div class="track__step' + (s.done ? " is-done" : "") +
                          (s.current ? " is-current" : "") + '">' +
                          '<span class="track__dot">' +
                            KT.icon(s.done ? "check" : "dot", s.done ? 15 : 10) + "</span>" +
                          '<div class="track__text"><strong>' + s.label + "</strong>" +
                            "<span>" + s.time + "</span></div>" +
                        "</div>"
                      );
                    })
                    .join("") +
                "</div>"
              : '<p class="ceta">' + KT.icon("check", 16) + order.eta + "</p>") +

            (order.rider
              ? '<div class="ridercard">' +
                  '<span class="ridercard__avatar">' + KT.icon("bike", 20) + "</span>" +
                  "<div><strong>" + order.rider.name + "</strong><span>" + order.rider.vehicle + "</span></div>" +
                  '<button class="btn btn--ghost btn--sm" type="button" data-soon>' +
                    KT.icon("phone", 15) + "Call rider</button>" +
                "</div>"
              : "") +
          "</div>" +

          '<div class="panel">' +
            '<div class="panel__head"><h2>What you ordered</h2></div>' +
            '<div class="orderitems">' +
              order.lines
                .map(function (l) {
                  var item = KT.menu.byId(l.itemId);
                  if (!item) return "";
                  return (
                    '<div class="orderitem">' +
                      '<span class="ring"><img data-food alt="" src="' +
                        KT.images.src(item.image, "thumb") + '"></span>' +
                      '<div class="orderitem__text"><strong>' + item.name + "</strong>" +
                        "<span>" + (l.extras.length ? l.extras.join(" · ") : KT.naira(item.price) + " each") +
                        "</span></div>" +
                      '<span class="orderitem__qty">×' + l.qty + "</span>" +
                      '<span class="price">' + KT.naira(item.price * l.qty) + "</span>" +
                    "</div>"
                  );
                })
                .join("") +
            "</div>" +
          "</div>" +
        "</div>" +

        "<aside>" +
          '<div class="panel">' +
            '<div class="panel__head"><h2>Summary</h2></div>' +
            '<dl class="csum">' +
              "<div><dt>Subtotal</dt><dd>" + KT.naira(sub) + "</dd></div>" +
              "<div><dt>Delivery</dt><dd>" + (delivery ? KT.naira(delivery) : "₦0") + "</dd></div>" +
              "<div><dt>Service charge</dt><dd>" + KT.naira(service) + "</dd></div>" +
              '<div class="csum__total"><dt>Total</dt><dd class="price price--lg">' +
                KT.naira(sub + delivery + service) + "</dd></div>" +
            "</dl>" +
            '<div class="deliverycard" style="margin-top:16px">' +
              '<span class="deliverycard__icon">' + KT.icon("pin", 19) + "</span>" +
              "<div><strong>Delivered to</strong><p>" + order.address + "</p></div>" +
            "</div>" +
            '<div class="deliverycard" style="margin-top:10px">' +
              '<span class="deliverycard__icon">' + KT.icon("wallet", 19) + "</span>" +
              "<div><strong>Payment</strong><p>Card ending 4242 · placeholder</p></div>" +
            "</div>" +
            '<div style="display:grid;gap:10px;margin-top:16px">' +
              '<button class="btn btn--primary btn--block" type="button" data-reorder="' + order.id + '">' +
                "Reorder these items</button>" +
              '<button class="btn btn--ghost btn--block" type="button" data-soon>Get help with this order</button>' +
            "</div>" +
            '<div class="phasenote" style="margin-top:6px">' + KT.icon("lock", 16) +
              "<span>Tracking, receipts and support are mock data in Phase 1.</span></div>" +
          "</div>" +
        "</aside>" +
      "</div>"
    );

    KT.images.bindAll(document);

    document.addEventListener("click", function (e) {
      if (e.target.closest("[data-soon]")) {
        KT.toast("Order support arrives with the ordering release.", "info");
      }
      var b = e.target.closest("[data-reorder]");
      if (!b) return;
      order.lines.forEach(function (l) {
        KT.cart.add(l.itemId, l.qty);
      });
      KT.toast("Added back to your basket", "success", {
        action: "View basket",
        onAction: function () {
          KT.drawer.open();
        }
      });
    });
  };
})(window.KT || (window.KT = {}));
