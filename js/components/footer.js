/* ==========================================================================
   Kandy's Treats — Footer
   Contact details, social profiles and legal links all come from
   KT.config (js/config/app.js). Anything without a real value is NOT
   rendered, so this footer never ships a fake phone number or a link
   to "#". Fill in KT.config.business / .socials / .legal to turn them on.
   ========================================================================== */
(function (KT) {
  "use strict";

  var COLUMNS = [
    {
      title: "Order",
      links: [
        ["Full menu", "pages/menu.html"],
        ["Shawarma", "pages/menu.html?category=shawarma"],
        ["Specials", "pages/menu.html?category=specials"],
        ["Drinks", "pages/menu.html?category=drinks"]
      ]
    },
    {
      title: "Your account",
      /* Rendered by accountLinks() so the column can follow the session. */
      dynamic: "account",
      links: []
    },
    {
      title: "Kandy's",
      links: [
        ["Our story", "index.html#story"],
        ["Delivery areas", "index.html#delivery"],
        ["Catering enquiries", "index.html#catering"],
        ["Careers", "index.html#careers"]
      ]
    }
  ];

  /* Social profiles come from KT.config.socials. One with no URL is not
     rendered — a footer full of links to "#" is worse than a shorter footer. */
  function socialsHTML() {
    var list = (KT.config.socials || []).filter(function (s) { return s.url; });
    if (!list.length) return "";
    return '<div class="foot__socials">' +
      list.map(function (s) {
        return '<a class="foot__social" href="' + s.url + '" aria-label="Kandy\'s Treats on ' +
          s.name + '" target="_blank" rel="noopener noreferrer">' +
          KT.icon(s.id, 18) + "</a>";
      }).join("") +
    "</div>";
  }

  /* Contact rows, likewise: only what Kandy's has actually given us. */
  function contactHTML() {
    var b = KT.config.business || {};
    var rows = [];
    if (b.phone) {
      rows.push('<li><a href="tel:' + b.phone.replace(/[^+0-9]/g, "") + '">' +
        KT.icon("phone", 17) + "<span>" + b.phone + "</span></a></li>");
    }
    if (b.whatsapp) {
      rows.push('<li><a href="https://wa.me/' + b.whatsapp.replace(/[^0-9]/g, "") +
        '" target="_blank" rel="noopener noreferrer">' + KT.icon("whatsapp", 17) +
        "<span>Chat on WhatsApp</span></a></li>");
    }
    if (b.email) {
      rows.push('<li><a href="mailto:' + b.email + '">' + KT.icon("mail", 17) +
        "<span>" + b.email + "</span></a></li>");
    }
    if (b.address) {
      rows.push("<li>" + KT.icon("pin", 17) + "<span>" + b.address + "</span></li>");
    }
    if (b.hours) {
      rows.push("<li>" + KT.icon("clock", 17) + "<span>" + b.hours + "</span></li>");
    }
    /* Always leave the service area, which we do know for certain. */
    rows.push("<li>" + KT.icon("bike", 17) + "<span>" +
      KT.config.serviceArea.label + "</span></li>");
    return '<ul class="foot__contact">' + rows.join("") + "</ul>";
  }

  function legalHTML() {
    var list = (KT.config.legal || []).filter(function (l) { return l.url; });
    if (!list.length) return "";
    return '<ul class="foot__legal">' +
      list.map(function (l) {
        return '<li><a href="' + l.url + '">' + l.name + "</a></li>";
      }).join("") +
    "</ul>";
  }

  KT.components = KT.components || {};

  /**
   * Session-aware links for the "Your account" column. While auth is still
   * resolving we show only the neutral entries — never "Sign in", which a
   * signed-in customer would otherwise see for a moment on every page load.
   */
  function accountLinks() {
    var neutral = [
      ["Order history", "pages/orders.html"],
      ["Saved addresses", "pages/account.html"]
    ];
    if (KT.authResolving && KT.authResolving()) return neutral;
    if (KT.auth && KT.auth.isSignedIn()) {
      return [["My account", "pages/account.html"]].concat(neutral);
    }
    return [["Sign in", "pages/login.html"], ["Create account", "pages/signup.html"]]
      .concat(neutral);
  }

  function paintAccountLinks() {
    var host = KT.qs("[data-foot-account]");
    if (!host) return;
    host.innerHTML = accountLinks().map(function (l) {
      return '<li><a href="' + KT.url(l[1]) + '">' + l[0] + "</a></li>";
    }).join("");
  }
  KT.components.paintFooterAccount = paintAccountLinks;

  KT.components.footer = function () {
    var host = KT.qs("[data-footer]");
    if (!host) return;

    var cols = COLUMNS.map(function (c) {
      return (
        '<div class="foot__col"><h3 class="foot__title">' + c.title + "</h3>" +
        "<ul" + (c.dynamic === "account" ? " data-foot-account" : "") + ">" +
        (c.dynamic === "account" ? accountLinks() : c.links)
          .map(function (l) {
            return '<li><a href="' + KT.url(l[1]) + '">' + l[0] + "</a></li>";
          })
          .join("") +
        "</ul></div>"
      );
    }).join("");

    host.innerHTML =
      '<footer class="foot" id="footer">' +
        '<div class="foot__glow" aria-hidden="true"></div>' +
        '<div class="wrap">' +
          '<div class="foot__top">' +
            '<div class="foot__brand">' +
              /* 1748x907 PNG rendered at 210x109. The WebP is sized for the
                 slot at 2x; the PNG stays as the fallback source. */
              '<picture>' +
                '<source type="image/webp" srcset="' +
                  KT.url("assets/logo/kandys-treats-wordmark.webp") + '">' +
                '<img class="foot__wordmark" src="' +
                  KT.url("assets/logo/kandys-treats-wordmark.png") +
                  '" alt="Kandy\'s Treats" width="210" height="109" ' +
                  'loading="lazy" decoding="async">' +
              '</picture>' +
              '<p class="foot__tagline">Nigerian kitchen serving Ado-Ekiti/Iworoko. Rice by the scoop, proteins and sides priced separately, processed after your order.</p>' +
              socialsHTML() +
            "</div>" +
            '<div class="foot__cols">' + cols +
              '<div class="foot__col">' +
                '<h3 class="foot__title">Get in touch</h3>' +
                contactHTML() +
              "</div>" +
            "</div>" +
          "</div>" +

          '<div class="foot__notes">' +
            '<div class="foot__note"><strong>Delivery</strong><span>Flat ' + KT.naira(KT.rules.DELIVERY_FEE) + ' anywhere we serve in ' + KT.config.serviceArea.state + ' State. Pickup is free — choose it in the basket.</span></div>' +
            '<div class="foot__note"><strong>Packaging</strong><span>Takeaway packs are added automatically: ₦200 per order, ₦300 when it includes ofada, or rice and beans together.</span></div>' +
            '<div class="foot__note"><strong>Payment</strong><span>Card and transfer payments are being switched on. Until then, place your basket and we will confirm payment with you directly.</span></div>' +
          "</div>" +

          '<div class="foot__bar">' +
            "<p>© " + new Date().getFullYear() + " Kandy's Treats. All rights reserved.</p>" +
            legalHTML() +
          "</div>" +
        "</div>" +
      "</footer>";
  };
})(window.KT || (window.KT = {}));
