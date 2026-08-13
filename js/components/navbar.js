/* ==========================================================================
   Kandy's Treats — Navigation
   Renders: promo strip, desktop/tablet header, mobile header, mobile sheet
   menu and the app-style bottom tab bar. One source of truth for all pages.
   ========================================================================== */
(function (KT) {
  "use strict";

  var LINKS = [
    { id: "home", label: "Home", href: "index.html", icon: "home" },
    { id: "menu", label: "Menu", href: "pages/menu.html", icon: "grid" },
    { id: "orders", label: "Orders", href: "pages/orders.html", icon: "receipt" },
    { id: "account", label: "Account", href: "pages/account.html", icon: "user" }
  ];

  function logo(cls) {
    return (
      '<a class="logo ' + (cls || "") + '" href="' + KT.url("index.html") + '" aria-label="Kandy\'s Treats — home">' +
      '<img src="' + KT.url("assets/logo/kandys-treats-logo.svg") + '" alt="Kandy\'s Treats" width="52" height="52">' +
      "</a>"
    );
  }

  function navbar(active) {
    var links = LINKS.map(function (l) {
      return (
        '<a class="nav__link' + (l.id === active ? " is-active" : "") + '" href="' +
        KT.url(l.href) + '"' + (l.id === active ? ' aria-current="page"' : "") + ">" +
        l.label + "</a>"
      );
    }).join("");

    var tabs = LINKS.slice(0, 2)
      .concat([{ id: "cart", label: "Cart", href: "pages/cart.html", icon: "cart" }])
      .concat(LINKS.slice(2))
      .map(function (l) {
        return (
          '<a class="tabbar__item' + (l.id === active ? " is-active" : "") + '" href="' +
          KT.url(l.href) + '"' + (l.id === "cart" ? ' data-tab-cart' : "") + ">" +
          '<span class="tabbar__icon">' + KT.icon(l.icon, 22) +
          (l.id === "cart" ? '<span class="tabbar__badge" data-cart-count hidden>0</span>' : "") +
          "</span><span>" + l.label + "</span></a>"
        );
      })
      .join("");

    return (
      /* ---- promo strip ------------------------------------------- */
      '<div class="promostrip">' +
        '<div class="wrap promostrip__inner">' +
          '<p class="promostrip__msg">' + KT.icon("bike", 16) +
            "<span>Free delivery over <strong>₦20,000</strong> — Island &amp; Mainland</span></p>" +
          '<p class="promostrip__msg promostrip__msg--alt">' + KT.icon("clock", 16) +
            "<span>Open today until <strong>10:00 PM</strong></span></p>" +
        "</div>" +
      "</div>" +

      /* ---- header ------------------------------------------------- */
      '<header class="nav" data-nav>' +
        '<div class="wrap nav__inner">' +
          '<div class="nav__left">' +
            logo() +
            '<button class="locpill" type="button" data-loc>' +
              '<span class="locpill__icon">' + KT.icon("pin", 17) + "</span>" +
              '<span class="locpill__text"><small>Deliver to</small><strong>Lekki Phase 1<span class="locpill__caret">' +
                KT.icon("chevronDown", 14) + "</span></strong></span>" +
            "</button>" +
          "</div>" +

          '<nav class="nav__links" aria-label="Primary">' + links + "</nav>" +

          '<div class="nav__right">' +
            '<a class="icon-btn nav__search" href="' + KT.url("pages/menu.html") + '#search" aria-label="Search the menu">' +
              KT.icon("search", 21) + "</a>" +
            '<button class="cartbtn" type="button" data-open-cart aria-label="Open cart">' +
              KT.icon("cart", 21) +
              '<span class="cartbtn__badge" data-cart-count hidden>0</span>' +
            "</button>" +
            '<a class="btn btn--primary btn--sm nav__cta" href="' + KT.url("pages/login.html") + '">Sign in</a>' +
            '<button class="icon-btn nav__burger" type="button" data-open-sheet aria-label="Open menu" aria-expanded="false">' +
              KT.icon("menu", 22) + "</button>" +
          "</div>" +
        "</div>" +
      "</header>" +

      /* ---- mobile sheet ------------------------------------------- */
      '<div class="sheet" data-sheet hidden>' +
        '<div class="sheet__scrim" data-close-sheet></div>' +
        '<div class="sheet__panel" role="dialog" aria-modal="true" aria-label="Menu">' +
          '<div class="sheet__head">' + logo("logo--sm") +
            '<button class="icon-btn" type="button" data-close-sheet aria-label="Close menu">' +
              KT.icon("close", 22) + "</button>" +
          "</div>" +
          '<div class="sheet__body">' +
            '<a class="sheet__loc" href="#">' + KT.icon("pin", 18) +
              "<span><small>Delivering to</small><strong>14B Admiralty Way, Lekki Phase 1</strong></span>" +
              KT.icon("chevronRight", 16) + "</a>" +
            '<nav class="sheet__nav" aria-label="Mobile">' +
              LINKS.concat([{ id: "cart", label: "Cart", href: "pages/cart.html", icon: "cart" }])
                .map(function (l) {
                  return (
                    '<a class="sheet__link' + (l.id === active ? " is-active" : "") + '" href="' +
                    KT.url(l.href) + '">' + KT.icon(l.icon, 21) + "<span>" + l.label + "</span>" +
                    KT.icon("chevronRight", 16) + "</a>"
                  );
                })
                .join("") +
            "</nav>" +
            '<div class="sheet__cats">' +
              '<p class="sheet__label">Browse by category</p>' +
              '<div class="sheet__catgrid">' +
                KT.menu.categories
                  .map(function (c) {
                    return (
                      '<a class="sheet__cat" href="' + KT.url("pages/menu.html?category=" + c.id) + '">' +
                      '<span class="ring sheet__catring"><img data-food src="' +
                      KT.images.src(c.image, "thumb") + '" alt=""></span>' + c.name + "</a>"
                    );
                  })
                  .join("") +
              "</div>" +
            "</div>" +
          "</div>" +
          '<div class="sheet__foot">' +
            '<a class="btn btn--primary btn--block" href="' + KT.url("pages/login.html") + '">Sign in</a>' +
            '<a class="btn btn--ghost btn--block" href="' + KT.url("pages/signup.html") + '">Create an account</a>' +
          "</div>" +
        "</div>" +
      "</div>" +

      /* ---- bottom tab bar (mobile) -------------------------------- */
      '<nav class="tabbar" aria-label="Mobile primary">' + tabs + "</nav>"
    );
  }

  KT.components = KT.components || {};

  KT.components.navbar = function (active) {
    var host = KT.qs("[data-navbar]");
    if (!host) return;
    host.innerHTML = navbar(active);
    KT.images.bindAll(host);

    /* Condense the header once the page scrolls. */
    var nav = KT.qs("[data-nav]");
    var onScroll = function () {
      var stuck = window.scrollY > 12;
      nav.classList.toggle("is-stuck", stuck);
      document.documentElement.classList.toggle("is-scrolled", stuck);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    /* Mobile sheet ------------------------------------------------- */
    var sheet = KT.qs("[data-sheet]");
    var burger = KT.qs("[data-open-sheet]");

    function openSheet() {
      sheet.hidden = false;
      requestAnimationFrame(function () {
        sheet.classList.add("is-open");
      });
      burger.setAttribute("aria-expanded", "true");
      KT.lockScroll(true);
    }
    function closeSheet() {
      sheet.classList.remove("is-open");
      burger.setAttribute("aria-expanded", "false");
      KT.lockScroll(false);
      setTimeout(function () {
        sheet.hidden = true;
      }, 280);
    }

    burger.addEventListener("click", openSheet);
    KT.qsa("[data-close-sheet]").forEach(function (b) {
      b.addEventListener("click", closeSheet);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !sheet.hidden) closeSheet();
    });

    /* Location pill is a visual placeholder in Phase 1. */
    var loc = KT.qs("[data-loc]");
    if (loc) {
      loc.addEventListener("click", function () {
        KT.toast("Address picker lands with the ordering release.", "info");
      });
    }

    /* Keep every cart badge in sync. */
    KT.cart.subscribe(function (_, sum) {
      KT.qsa("[data-cart-count]").forEach(function (b) {
        b.textContent = sum.count;
        b.hidden = sum.count === 0;
      });
      KT.qsa("[data-tab-cart]").forEach(function (t) {
        t.classList.toggle("has-items", sum.count > 0);
      });
    });
  };
})(window.KT || (window.KT = {}));
