/* ==========================================================================
   Kandy's Treats — Basket page
   Shares its line and summary renderers with the drawer so the two can never
   drift. Fulfilment, coupon and address choices here become the checkout
   draft that `createCheckoutOrder` validates server-side.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.pages = KT.pages || {};

  var addresses = [];
  var selectedAddressId = "";

  /* ---- Basket ---------------------------------------------------------- */

  function renderMain() {
    var lines = KT.cart.detailed();
    var host = KT.qs("[data-cart-main]");
    if (!host) return;

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
        lines.map(function (l) { return KT.components.cartLine(l); }).join("") +
      "</ul>";

    KT.images.bindAll(host);
  }

  /* ---- Fulfilment + address ------------------------------------------- */

  function addressPicker() {
    if (KT.cart.fulfilment() === "pickup") {
      return (
        '<div class="deliverycard">' +
          '<span class="deliverycard__icon">' + KT.icon("pin", 19) + "</span>" +
          "<div><strong>Collect from Kandy's</strong>" +
          "<p>Pick your order up yourself — no delivery fee. We will call when it is ready.</p></div>" +
        "</div>"
      );
    }

    if (!KT.auth || !KT.auth.user()) {
      return (
        '<div class="deliverycard">' +
          '<span class="deliverycard__icon">' + KT.icon("lock", 19) + "</span>" +
          "<div><strong>Sign in to add an address</strong>" +
          "<p>Delivery addresses are saved to your account so the rider always has the right one.</p>" +
          '<a class="deliverycard__change" href="' + KT.url("pages/login.html?next=cart") +
            '">Sign in or create an account</a></div>' +
        "</div>"
      );
    }

    if (!addresses.length) {
      return (
        '<div class="deliverycard">' +
          '<span class="deliverycard__icon">' + KT.icon("pin", 19) + "</span>" +
          "<div><strong>No saved address yet</strong>" +
          "<p>" + KT.config.serviceArea.note + "</p>" +
          '<a class="deliverycard__change" href="' + KT.url("pages/account.html#addresses") +
            '">Add a delivery address</a></div>' +
        "</div>"
      );
    }

    return addresses.map(function (a) {
      var on = a.id === selectedAddressId;
      return (
        '<button class="deliverycard" type="button" data-pick-address="' + a.id + '"' +
          (on ? ' style="border-color:var(--kt-pink);background:var(--kt-pink-50)"' : "") + ">" +
          '<span class="deliverycard__icon">' + KT.icon(on ? "check" : "pin", 19) + "</span>" +
          "<div><strong>" + a.label + (a.isDefault ? " · Default" : "") + "</strong>" +
          "<p>" + a.address + "</p>" +
          (a.recipientName || a.phone
            ? "<small>" + [a.recipientName, KT.rules.displayPhone(a.phone)].filter(Boolean).join(" · ") + "</small>"
            : "") +
          "</div>" +
        "</button>"
      );
    }).join("") +
      '<a class="deliverycard__change" href="' + KT.url("pages/account.html#addresses") +
      '">Manage addresses</a>';
  }

  function renderSide() {
    var sum = KT.cart.summary();
    var host = KT.qs("[data-cart-side]");
    if (!host) return;
    var empty = sum.count === 0;
    var needsAddress = sum.fulfilment === "delivery" && !selectedAddressId;
    var signedIn = !!(KT.auth && KT.auth.user());

    host.innerHTML =
      '<div class="cartpanel">' +
        "<h3>How would you like it?</h3>" +
        '<div class="slotpicker" role="group" aria-label="Fulfilment">' +
          KT.rules.FULFILMENTS.map(function (f) {
            var on = sum.fulfilment === f;
            return '<button class="chip' + (on ? " is-active" : "") + '" type="button" ' +
              'data-fulfilment="' + f + '" aria-pressed="' + on + '">' +
              KT.icon(f === "delivery" ? "bike" : "pin", 15) +
              (f === "delivery" ? "Deliver to me" : "I'll pick it up") + "</button>";
          }).join("") +
        "</div>" +
        '<div class="slotpicker" style="flex-direction:column;align-items:stretch;gap:8px">' +
          addressPicker() + "</div>" +
        (sum.eta ? KT.components.cartEta(sum) : "") +
      "</div>" +

      '<div class="cartpanel">' +
        "<h3>Order summary</h3>" +
        '<form class="promoform" data-promo-form>' +
          '<label class="sr-only" for="promoCode">Promo code</label>' +
          '<input class="input" id="promoCode" placeholder="Promo code" autocomplete="off" value="' +
            (sum.couponCode || "") + '">' +
          '<button class="btn btn--ghost" type="submit">' +
            (sum.couponCode ? "Remove" : "Apply") + "</button>" +
        "</form>" +
        '<p class="field__hint" data-promo-msg></p>' +
        KT.components.cartSummary(sum) +
        '<button class="btn btn--primary btn--lg btn--block" type="button" data-checkout' +
          (empty || sum.hasSoldOut ? " disabled" : "") + ">" +
          (signedIn ? "Continue to payment" : "Sign in to check out") +
          KT.icon("arrowRight", 18) + "</button>" +
        (needsAddress && !empty && signedIn
          ? '<p class="field__hint" style="color:var(--chili)">Choose a delivery address first.</p>'
          : "") +
        (sum.hasSoldOut
          ? '<p class="field__hint" style="color:var(--chili)">Remove the sold-out items to continue.</p>'
          : "") +
        '<div class="phasenote">' + KT.icon("lock", 16) +
          "<span>Totals are recalculated on our server before payment. Card details never touch this site — " +
          "Paystack and Flutterwave handle them.</span></div>" +
      "</div>";
  }

  function suggestions() {
    var host = KT.qs("[data-cart-suggest]");
    if (!host) return;
    var inBasket = KT.cart.lines().map(function (l) { return l.menuId; });
    var picks = KT.menu.byCategory("drinks")
      .concat(KT.menu.byCategory("sides"))
      .filter(function (i) { return inBasket.indexOf(i.id) === -1 && KT.menu.available(i); })
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

  /* ---- Data ------------------------------------------------------------ */

  function loadAddresses() {
    if (!KT.services || !KT.auth || !KT.auth.user()) return;
    KT.services.addresses.list().then(function (list) {
      addresses = list || [];
      var preferred = addresses.filter(function (a) { return a.isDefault; })[0] || addresses[0];
      if (!selectedAddressId && preferred) selectedAddressId = preferred.id;
      renderSide();
    }).catch(function () { /* offline — the picker shows the signed-out state */ });
  }

  async function checkout() {
    if (!KT.services) {
      KT.toast("Still connecting to Kandy's — try again in a moment.", "info");
      return;
    }
    var user = KT.auth && KT.auth.user();
    if (!user) {
      window.location.href = KT.url("pages/login.html?next=cart");
      return;
    }
    if (!KT.menu.live) {
      KT.toast("We could not confirm today's menu. Refresh and try again.", "error");
      return;
    }

    var sum = KT.cart.summary();
    if (sum.fulfilment === "delivery" && !selectedAddressId) {
      KT.toast("Choose a delivery address first.", "info");
      return;
    }

    var btn = KT.qs("[data-checkout]");
    btn.disabled = true;
    btn.textContent = "Creating your order…";

    try {
      var profile = await KT.services.account.profile();
      var address = addresses.filter(function (a) { return a.id === selectedAddressId; })[0];
      var draft = KT.cart.toDraft(selectedAddressId, {
        name: (profile && profile.displayName) || (address && address.recipientName) || user.displayName || "",
        phone: (profile && profile.phone) || (address && address.phone) || "",
        email: user.email || ""
      });

      var order = await KT.services.orders.createCheckout([draft], "gateway");
      window.location.href = KT.url("pages/order-detail.html?id=" + encodeURIComponent(order.orderId) + "&pay=1");
    } catch (error) {
      btn.disabled = false;
      btn.innerHTML = "Continue to payment" + KT.icon("arrowRight", 18);
      KT.toast(KT.services.errorMessage(error), "error", { duration: 5200 });
    }
  }

  /* ---- Wiring ---------------------------------------------------------- */

  KT.pages.cart = function () {
    paint();
    KT.cart.subscribe(KT.debounce(paint, 40));
    document.addEventListener("kt:auth", function () {
      selectedAddressId = "";
      addresses = [];
      loadAddresses();
      renderSide();
    });
    document.addEventListener("kt:menu", paint);
    loadAddresses();

    document.addEventListener("click", function (e) {
      var f = e.target.closest("[data-fulfilment]");
      if (f) KT.cart.setFulfilment(f.getAttribute("data-fulfilment"));

      var a = e.target.closest("[data-pick-address]");
      if (a) {
        selectedAddressId = a.getAttribute("data-pick-address");
        renderSide();
      }

      if (e.target.closest("[data-checkout]")) checkout();
    });

    document.addEventListener("submit", function (e) {
      var form = e.target.closest("[data-promo-form]");
      if (!form) return;
      e.preventDefault();
      var input = KT.qs("input", form);
      var result = KT.cart.applyCoupon(KT.cart.summary().couponCode ? "" : input.value);
      var msg = KT.qs("[data-promo-msg]");
      if (msg) {
        msg.textContent = result.message;
        msg.style.color = result.ok ? "var(--mint)" : "var(--chili)";
      }
    });
  };
})(window.KT || (window.KT = {}));
