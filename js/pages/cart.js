/* ==========================================================================
   Kandy's Treats — Cart page
   Shares its line/summary renderers with the drawer. Checkout is a visual
   placeholder in Phase 1 — no order is created, no payment is taken.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.pages = KT.pages || {};

  var SLOTS = ["As soon as possible", "Within the hour", "Pick a time"];

  function renderMain() {
    var lines = KT.cart.detailed();
    var host = KT.qs("[data-cart-main]");

    if (!lines.length) {
      host.innerHTML = KT.components.cartEmpty();
      return;
    }

    host.innerHTML =
      '<div class="cartpage__head">' +
        "<h2>" + KT.plural(KT.cart.count(), "item") + " in your basket</h2>" +
        '<button class="cline__remove" type="button" data-clear-cart>' +
          KT.icon("trash", 15) + "<span>Empty basket</span></button>" +
      "</div>" +
      KT.components.cartProgress(KT.cart.summary()) +
      '<ul class="clines">' +
        lines.map(function (l) {
          return KT.components.cartLine(l);
        }).join("") +
      "</ul>";

    KT.images.bindAll(host);
  }

  function renderSide() {
    var sum = KT.cart.summary();
    var addr = KT.account.profile.addresses[0];
    var host = KT.qs("[data-cart-side]");
    var empty = sum.count === 0;

    host.innerHTML =
      '<div class="cartpanel">' +
        "<h3>Delivery</h3>" +
        '<div class="deliverycard">' +
          '<span class="deliverycard__icon">' + KT.icon("pin", 19) + "</span>" +
          "<div><strong>" + addr.label + "</strong><p>" + addr.line + ", " + addr.city + "</p>" +
          '<button class="deliverycard__change" type="button" data-soon>Change address</button></div>' +
        "</div>" +
        '<div class="slotpicker" role="group" aria-label="Delivery time">' +
          SLOTS.map(function (s, i) {
            return '<button class="chip' + (i === 0 ? " is-active" : "") +
              '" type="button" data-slot>' + s + "</button>";
          }).join("") +
        "</div>" +
        (sum.eta
          ? '<p class="ceta">' + KT.icon("clock", 16) + "Estimated arrival <strong>" +
            sum.eta + "–" + (sum.eta + 15) + " min</strong><em>placeholder timing — live ETA arrives with the ordering release</em></p>"
          : "") +
      "</div>" +

      '<div class="cartpanel">' +
        "<h3>Order summary</h3>" +
        '<form class="promoform" data-promo-form>' +
          '<label class="sr-only" for="promoCode">Promo code</label>' +
          '<input class="input" id="promoCode" placeholder="Promo code" autocomplete="off">' +
          '<button class="btn btn--ghost" type="submit">Apply</button>' +
        "</form>" +
        KT.components.cartSummary(sum) +
        '<button class="btn btn--primary btn--lg btn--block" type="button" data-checkout' +
          (empty ? " disabled" : "") + ">Continue to checkout" + KT.icon("arrowRight", 18) + "</button>" +
        '<div class="phasenote">' + KT.icon("lock", 16) +
          "<span><strong>Phase 1 build.</strong> Checkout and payment are not wired up yet — this button confirms the flow visually only.</span></div>" +
      "</div>";
  }

  function suggestions() {
    var host = KT.qs("[data-cart-suggest]");
    if (!host) return;
    var inBasket = KT.cart.lines().map(function (l) {
      return l.itemId;
    });
    var picks = KT.menu
      .byCategory("drinks")
      .concat(KT.menu.byCategory("desserts"))
      .filter(function (i) {
        return inBasket.indexOf(i.id) === -1;
      })
      .slice(0, 4);
    host.innerHTML = KT.components.foodCards(picks);
    KT.images.bindAll(host);
    KT.components.paintCards(host);
  }

  function paint() {
    renderMain();
    renderSide();
    suggestions();
  }

  KT.pages.cart = function () {
    paint();
    KT.cart.subscribe(KT.debounce(paint, 40));

    document.addEventListener("click", function (e) {
      if (e.target.closest("[data-slot]")) {
        var b = e.target.closest("[data-slot]");
        KT.qsa("[data-slot]").forEach(function (x) {
          x.classList.toggle("is-active", x === b);
        });
      }
      if (e.target.closest("[data-soon]")) {
        KT.toast("Address management arrives with accounts.", "info");
      }
      if (e.target.closest("[data-checkout]")) {
        KT.toast(
          "Checkout is not part of Phase 1 — the UI stops here on purpose.",
          "info",
          { duration: 4600 }
        );
      }
    });

    document.addEventListener("submit", function (e) {
      if (!e.target.closest("[data-promo-form]")) return;
      e.preventDefault();
      KT.toast("Promo codes go live with the ordering release.", "info");
    });
  };
})(window.KT || (window.KT = {}));
