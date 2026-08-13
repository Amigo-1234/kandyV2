/* ==========================================================================
   Kandy's Treats — Bootstrap
   Every page loads this last. It reads <body data-page="…">, mounts the
   shared shell, then hands off to the matching page module in js/pages/.
   ========================================================================== */
(function (KT) {
  "use strict";

  /** Sticky "view basket" bar — mobile only, appears once the cart fills. */
  function stickyCartBar() {
    var bar = document.createElement("button");
    bar.type = "button";
    bar.className = "stickycart";
    bar.setAttribute("data-open-cart", "");
    bar.innerHTML =
      '<span class="stickycart__left"><span class="stickycart__count" data-sc-count>0</span>' +
      "<span>View basket</span></span>" +
      '<span class="stickycart__right" data-sc-total>₦0</span>';
    document.body.appendChild(bar);

    KT.cart.subscribe(function (_, sum) {
      bar.classList.toggle("is-visible", sum.count > 0);
      KT.qs("[data-sc-count]", bar).textContent = sum.count;
      KT.qs("[data-sc-total]", bar).textContent = KT.naira(sum.total);
    });
  }

  /** Fill any <span data-icon="cart"> placeholder with the inline SVG. */
  function paintIcons(root) {
    KT.qsa("[data-icon]", root).forEach(function (n) {
      if (n.dataset.iconDone) return;
      n.dataset.iconDone = "1";
      n.innerHTML = KT.icon(n.getAttribute("data-icon"),
        Number(n.getAttribute("data-icon-size")) || 18);
    });
  }

  function start() {
    var page = document.body.getAttribute("data-page") || "home";

    KT.components.navbar(page);
    KT.components.footer();
    KT.drawer.init();
    KT.quicklook.init();
    KT.components.bindCards();
    stickyCartBar();

    /* One honest line if the backend never came up. The storefront still
       browses from the bundled snapshot; ordering stays disabled. */
    document.addEventListener("kt:services", function (e) {
      if (e.detail.ok) {
        var existing = KT.qs("[data-offline-note]");
        if (existing) existing.remove();
        return;
      }
      if (KT.qs("[data-offline-note]")) return;
      var note = KT.el("p.offline-note", { "data-offline-note": true, html:
        KT.icon("close", 15) +
        "<span>We can't reach Kandy's right now — you can browse the menu, " +
        "but ordering is paused. Check your connection and reload.</span>" });
      var nav = KT.qs("[data-nav]");
      if (nav && nav.parentNode) nav.parentNode.insertBefore(note, nav);
      else document.body.prepend(note);
    });

    if (KT.pages && typeof KT.pages[page] === "function") {
      try {
        KT.pages[page]();
      } catch (err) {
        /* A single broken page module must never take the shell down. */
        console.error("[Kandy's Treats] page module '" + page + "' failed:", err);
      }
    }

    KT.components.paintCards(document);
    paintIcons(document);
    KT.images.bindAll(document);
    KT.motion.reveal();
    KT.motion.parallax();
    KT.motion.rails();

    document.documentElement.classList.add("is-ready");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})(window.KT || (window.KT = {}));
