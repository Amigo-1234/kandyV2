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
      '<img src="' + KT.url("assets/logo/kandys-treats-logo.png") + '" alt="Kandy\'s Treats" width="52" height="52">' +
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
            "<span>Flat <strong>" + KT.naira(KT.rules.DELIVERY_FEE) +
            "</strong> delivery across " + KT.config.serviceArea.state + " State</span></p>" +
          '<p class="promostrip__msg promostrip__msg--alt">' + KT.icon("gift", 16) +
            "<span><strong>" + KT.rules.COUPONS.KANDY10.code + "</strong> — " +
            KT.rules.COUPONS.KANDY10.value + "% off over " +
            KT.naira(KT.rules.COUPONS.KANDY10.minSubtotal) + "</span></p>" +
        "</div>" +
      "</div>" +

      /* ---- header ------------------------------------------------- */
      '<header class="nav" data-nav>' +
        '<div class="wrap nav__inner">' +
          '<div class="nav__left">' +
            logo() +
            '<button class="locpill" type="button" data-loc>' +
              '<span class="locpill__icon">' + KT.icon("pin", 17) + "</span>" +
              '<span class="locpill__text"><small>Deliver to</small><strong data-loc-label>' +
                KT.config.serviceArea.state + ' State<span class="locpill__caret">' +
                KT.icon("chevronDown", 14) + "</span></strong></span>" +
            "</button>" +
          "</div>" +

          '<nav class="nav__links" aria-label="Primary">' + links + "</nav>" +

          '<div class="nav__right">' +
            '<a class="icon-btn nav__search" href="' + KT.url("pages/menu.html") + '#search" aria-label="Search the menu">' +
              KT.icon("search", 21) + "</a>" +
            /* Icon and labels are filled in by KT.theme.paintToggles(), which
               knows the current theme; rendering it empty here keeps the
               navbar markup theme-agnostic. */
            '<button class="icon-btn nav__theme" type="button" data-theme-toggle ' +
              'aria-label="Switch theme" title="Switch theme"></button>' +
            /* The bell renders itself: KT.components.notifications owns the
               three auth states and the unread count, and repaints this slot
               on every kt:auth signal. */
            '<span class="nav__notif" data-notif-slot></span>' +
            '<button class="cartbtn" type="button" data-open-cart aria-label="Open cart">' +
              KT.icon("cart", 21) +
              '<span class="cartbtn__badge" data-cart-count hidden>0</span>' +
            "</button>" +
            '<span data-auth-cta>' + authCtaHTML() + "</span>" +
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
            '<a class="sheet__loc" href="' + KT.url("pages/account.html#addresses") + '">' +
              KT.icon("pin", 18) +
              "<span><small>Delivering to</small><strong data-sheet-address>Add your delivery address</strong></span>" +
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
                      KT.images.src(c.image) + '" alt=""></span>' + c.name + "</a>"
                    );
                  })
                  .join("") +
              "</div>" +
            "</div>" +
          "</div>" +
          '<div class="sheet__foot" data-auth-sheet-cta>' + authSheetHTML() + "</div>" +
        "</div>" +
      "</div>" +

      /* ---- bottom tab bar (mobile) -------------------------------- */
      '<nav class="tabbar" aria-label="Mobile primary">' + tabs + "</nav>"
    );
  }

  KT.components = KT.components || {};

  /**
   * The header CTA, driven by the real Supabase session rather than a cached
   * flag. THREE states, not two — the hydrating state is what stops a
   * signed-in customer seeing "Sign in" for a moment on every page load. It
   * keeps the button's footprint (visibility, not display), so resolving
   * cannot shift the layout.
   */
  function authCtaHTML() {
    if (KT.authResolving && KT.authResolving()) {
      return '<a class="btn btn--primary btn--sm nav__cta" href="' + KT.url("pages/account.html") +
        '" style="visibility:hidden" aria-hidden="true" tabindex="-1">My account</a>';
    }
    if (KT.auth && KT.auth.isSignedIn()) {
      return '<a class="btn btn--soft btn--sm nav__cta" href="' + KT.url("pages/account.html") +
        '">My account</a>';
    }
    return '<a class="btn btn--primary btn--sm nav__cta" href="' + KT.url("pages/login.html") +
      '">Sign in</a>';
  }

  /** The same three states for the mobile sheet's footer. */
  function authSheetHTML() {
    if (KT.authResolving && KT.authResolving()) {
      return '<a class="btn btn--primary btn--block" href="' + KT.url("pages/account.html") +
        '" style="visibility:hidden" aria-hidden="true" tabindex="-1">My account</a>';
    }
    if (KT.auth && KT.auth.isSignedIn()) {
      return '<a class="btn btn--primary btn--block" href="' + KT.url("pages/account.html") +
          '">My account</a>' +
        '<a class="btn btn--ghost btn--block" href="' + KT.url("pages/orders.html") +
          '">Order history</a>';
    }
    return '<a class="btn btn--primary btn--block" href="' + KT.url("pages/login.html") +
        '">Sign in</a>' +
      '<a class="btn btn--ghost btn--block" href="' + KT.url("pages/signup.html") +
        '">Create an account</a>';
  }

  /** Repaint both CTAs in place. Cheap, and safe to call repeatedly. */
  function paintAuthCta() {
    var cta = KT.qs("[data-auth-cta]");
    if (cta) cta.innerHTML = authCtaHTML();
    var sheet = KT.qs("[data-auth-sheet-cta]");
    if (sheet) sheet.innerHTML = authSheetHTML();
    /* The bell shares the CTA's three states, so it repaints on the same
       signals rather than listening for auth a second time. */
    if (KT.components.notifications) KT.components.notifications.paint();
  }
  KT.components.paintAuthCta = paintAuthCta;

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
        window.location.href = KT.url("pages/account.html#addresses");
      });
    }

    /* Live announcements replace the built-in strip copy when the kitchen
       has published any. Falls back to the standing delivery/coupon message. */
    function paintAnnouncements(list) {
      if (!list || !list.length) return;
      var strip = KT.qs(".promostrip__inner");
      if (!strip) return;
      strip.innerHTML = list.slice(0, 2).map(function (a, i) {
        return '<p class="promostrip__msg' + (i ? " promostrip__msg--alt" : "") + '">' +
          KT.icon(i ? "gift" : "sparkle", 16) + "<span>" + a.text + "</span></p>";
      }).join("");
    }

    document.addEventListener("kt:services", function (e) {
      if (!e.detail.ok || !KT.services) return;
      KT.services.content.announcements().then(paintAnnouncements).catch(function () {});
    });

    /* Once signed in, show the customer's default delivery address. */
    function paintAddress(list) {
      var pick = (list || []).filter(function (a) { return a.isDefault; })[0] || (list || [])[0];
      if (!pick) return;
      var short = pick.label || pick.address;
      KT.qsa("[data-loc-label]").forEach(function (n) {
        n.firstChild.nodeValue = short;
      });
      KT.qsa("[data-sheet-address]").forEach(function (n) {
        n.textContent = pick.address;
      });
    }

    /* The session is the source of truth, so repaint on every auth signal and
       when services publish — that is when a restored session first lands. */
    document.addEventListener("kt:auth", paintAuthCta);
    document.addEventListener("kt:services", paintAuthCta);
    paintAuthCta();

    document.addEventListener("kt:auth", function (e) {
      if (!e.detail.signedIn || !KT.services) return;
      KT.services.addresses.list().then(paintAddress).catch(function () {});
    });

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
