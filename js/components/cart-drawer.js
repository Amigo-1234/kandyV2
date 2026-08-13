/* ==========================================================================
   Kandy's Treats — Cart drawer
   Side panel on desktop, bottom sheet on mobile. Shares its line-item and
   summary renderers with the full cart page (js/pages/cart.js) so the two
   can never drift apart.
   ========================================================================== */
(function (KT) {
  "use strict";

  /* ---- Shared renderers --------------------------------------------- */

  function line(l, compact) {
    return (
      '<li class="cline' + (compact ? " cline--compact" : "") + '" data-line="' + l.key + '">' +
        '<a class="cline__media ring" href="' + KT.url("pages/product.html?id=" + l.item.id) + '">' +
          '<img data-food alt="" src="' + KT.images.src(l.item.image, "thumb") + '">' +
        "</a>" +
        '<div class="cline__body">' +
          '<div class="cline__top">' +
            '<h4 class="cline__name"><a href="' + KT.url("pages/product.html?id=" + l.item.id) + '">' +
              l.item.name + "</a></h4>" +
            '<span class="cline__total price">' + KT.naira(l.total) + "</span>" +
          "</div>" +
          (l.extras.length
            ? '<p class="cline__extras">' + l.extras.join(" · ") + "</p>"
            : '<p class="cline__extras cline__extras--empty">' + KT.naira(l.unit) + " each</p>") +
          '<div class="cline__controls">' +
            '<div class="stepper">' +
              '<button class="stepper__btn" type="button" data-line-dec="' + l.key + '" aria-label="Decrease quantity">' +
                KT.icon("minus", 16) + "</button>" +
              '<span class="stepper__value">' + l.qty + "</span>" +
              '<button class="stepper__btn" type="button" data-line-inc="' + l.key + '" aria-label="Increase quantity">' +
                KT.icon("plus", 16) + "</button>" +
            "</div>" +
            '<button class="cline__remove" type="button" data-line-remove="' + l.key + '">' +
              KT.icon("trash", 16) + "<span>Remove</span></button>" +
          "</div>" +
        "</div>" +
      "</li>"
    );
  }

  function progress(sum) {
    if (sum.count === 0) return "";
    if (sum.freeDeliveryGap === 0) {
      return (
        '<div class="cprog cprog--done">' + KT.icon("bike", 17) +
        "<p>Nice — <strong>delivery is on us</strong> for this order.</p></div>"
      );
    }
    var pct = Math.min(
      100,
      Math.round((sum.subtotal / KT.cart.FREE_DELIVERY_FROM) * 100)
    );
    return (
      '<div class="cprog">' +
        "<p>" + KT.icon("bike", 17) + "Add <strong>" + KT.naira(sum.freeDeliveryGap) +
          "</strong> more for free delivery</p>" +
        '<div class="cprog__track"><span style="width:' + pct + '%"></span></div>' +
      "</div>"
    );
  }

  function summary(sum) {
    return (
      '<dl class="csum">' +
        "<div><dt>Subtotal</dt><dd>" + KT.naira(sum.subtotal) + "</dd></div>" +
        "<div><dt>Delivery" +
          (sum.delivery === 0 && sum.subtotal > 0 ? ' <em class="csum__free">free</em>' : "") +
          "</dt><dd>" + (sum.delivery === 0 ? "₦0" : KT.naira(sum.delivery)) + "</dd></div>" +
        "<div><dt>Service charge</dt><dd>" + KT.naira(sum.service) + "</dd></div>" +
        '<div class="csum__total"><dt>Total</dt><dd class="price price--lg">' +
          KT.naira(sum.total) + "</dd></div>" +
      "</dl>"
    );
  }

  function eta(sum) {
    if (!sum.eta) return "";
    return (
      '<p class="ceta">' + KT.icon("clock", 16) +
      "Estimated arrival <strong>" + sum.eta + "–" + (sum.eta + 15) + " min</strong>" +
      '<em>placeholder — live timing arrives with the ordering release</em></p>'
    );
  }

  function emptyState() {
    return (
      '<div class="empty">' +
        '<div class="empty__art">' + KT.icon("cart", 40) + "</div>" +
        "<h3>Your basket is empty</h3>" +
        "<p>Pick something from the menu — jollof, small chops and meat pies are what people usually start with.</p>" +
        '<a class="btn btn--primary" href="' + KT.url("pages/menu.html") + '">Browse the menu</a>' +
      "</div>"
    );
  }

  /* ---- Drawer -------------------------------------------------------- */

  var el = {};

  function build() {
    var node = document.createElement("div");
    node.className = "drawer";
    node.hidden = true;
    node.innerHTML =
      '<div class="drawer__scrim" data-close-cart></div>' +
      '<aside class="drawer__panel" role="dialog" aria-modal="true" aria-label="Your basket">' +
        '<header class="drawer__head">' +
          '<span class="drawer__grab" aria-hidden="true"></span>' +
          "<h2>Your basket <em data-drawer-count>0</em></h2>" +
          '<button class="icon-btn" type="button" data-close-cart aria-label="Close basket">' +
            KT.icon("close", 22) + "</button>" +
        "</header>" +
        '<div class="drawer__body" data-drawer-body></div>' +
        '<footer class="drawer__foot" data-drawer-foot hidden></footer>' +
      "</aside>";
    document.body.appendChild(node);
    el.root = node;
    el.body = KT.qs("[data-drawer-body]", node);
    el.foot = KT.qs("[data-drawer-foot]", node);
    el.count = KT.qs("[data-drawer-count]", node);

    KT.qsa("[data-close-cart]", node).forEach(function (b) {
      b.addEventListener("click", close);
    });
  }

  function render() {
    var lines = KT.cart.detailed();
    var sum = KT.cart.summary();
    el.count.textContent = sum.count ? "(" + sum.count + ")" : "";

    if (!lines.length) {
      el.body.innerHTML = emptyState();
      el.foot.hidden = true;
      return;
    }

    el.body.innerHTML =
      progress(sum) +
      '<ul class="clines">' + lines.map(function (l) { return line(l, true); }).join("") + "</ul>" +
      '<button class="drawer__clear" type="button" data-clear-cart>' +
        KT.icon("trash", 15) + "Empty basket</button>";

    el.foot.hidden = false;
    el.foot.innerHTML =
      eta(sum) + summary(sum) +
      '<a class="btn btn--primary btn--lg btn--block" href="' + KT.url("pages/cart.html") + '">' +
        "Go to checkout" + KT.icon("arrowRight", 18) + "</a>" +
      '<button class="drawer__keep" type="button" data-close-cart>Keep browsing</button>';

    KT.qs("[data-close-cart]", el.foot).addEventListener("click", close);
    KT.images.bindAll(el.body);
  }

  function open() {
    if (!el.root) build();
    render();
    el.root.hidden = false;
    requestAnimationFrame(function () {
      el.root.classList.add("is-open");
    });
    KT.lockScroll(true);
  }

  function close() {
    if (!el.root) return;
    el.root.classList.remove("is-open");
    KT.lockScroll(false);
    setTimeout(function () {
      el.root.hidden = true;
    }, 320);
  }

  function init() {
    build();

    document.addEventListener("click", function (e) {
      if (e.target.closest("[data-open-cart]")) {
        e.preventDefault();
        open();
      }
      var inc = e.target.closest("[data-line-inc]");
      var dec = e.target.closest("[data-line-dec]");
      var rm = e.target.closest("[data-line-remove]");
      var clr = e.target.closest("[data-clear-cart]");

      if (inc) KT.cart.bump(inc.getAttribute("data-line-inc"), 1);
      if (dec) KT.cart.bump(dec.getAttribute("data-line-dec"), -1);
      if (rm) {
        var el2 = rm.closest("[data-line]");
        if (el2) el2.classList.add("is-leaving");
        var key = rm.getAttribute("data-line-remove");
        setTimeout(function () {
          KT.cart.remove(key);
        }, 180);
      }
      if (clr) {
        KT.cart.clear();
        KT.toast("Basket emptied", "info");
      }
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && el.root && !el.root.hidden) close();
    });

    KT.cart.subscribe(function () {
      if (el.root && !el.root.hidden) render();
    });
  }

  KT.drawer = { open: open, close: close, init: init };
  KT.components = KT.components || {};
  KT.components.cartLine = line;
  KT.components.cartSummary = summary;
  KT.components.cartProgress = progress;
  KT.components.cartEta = eta;
  KT.components.cartEmpty = emptyState;
})(window.KT || (window.KT = {}));
