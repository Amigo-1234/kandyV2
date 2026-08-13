/* ==========================================================================
   Kandy's Treats — Footer
   Contact details, hours and social handles are placeholders (marked with
   data-placeholder) so they are easy to find and replace with real details.
   ========================================================================== */
(function (KT) {
  "use strict";

  var COLUMNS = [
    {
      title: "Order",
      links: [
        ["Full menu", "pages/menu.html"],
        ["Combos & bundles", "pages/menu.html?category=combos"],
        ["Party trays", "pages/menu.html?category=snacks"],
        ["Today's deals", "pages/menu.html?filter=deal"]
      ]
    },
    {
      title: "Your account",
      links: [
        ["Sign in", "pages/login.html"],
        ["Create account", "pages/signup.html"],
        ["Order history", "pages/orders.html"],
        ["Saved addresses", "pages/account.html"]
      ]
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

  var SOCIALS = [
    ["Instagram", "IG"],
    ["TikTok", "TT"],
    ["X", "X"],
    ["WhatsApp", "WA"]
  ];

  KT.components = KT.components || {};

  KT.components.footer = function () {
    var host = KT.qs("[data-footer]");
    if (!host) return;

    var cols = COLUMNS.map(function (c) {
      return (
        '<div class="foot__col"><h3 class="foot__title">' + c.title + "</h3><ul>" +
        c.links
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
              '<img class="foot__logo" src="' + KT.url("assets/logo/kandys-treats-logo.svg") +
                '" alt="Kandy\'s Treats" width="72" height="72">' +
              '<p class="foot__tagline">Nigerian kitchen and bakery, delivered hot across Lagos. Cooked to order, never held under a lamp.</p>' +
              '<div class="foot__socials">' +
                SOCIALS.map(function (s) {
                  return (
                    '<a class="foot__social" href="#" data-placeholder aria-label="' +
                    s[0] + '"><span>' + s[1] + "</span></a>"
                  );
                }).join("") +
              "</div>" +
            "</div>" +
            '<div class="foot__cols">' + cols +
              '<div class="foot__col">' +
                '<h3 class="foot__title">Get in touch</h3>' +
                '<ul class="foot__contact">' +
                  '<li data-placeholder>' + KT.icon("phone", 17) + "<span>+234 800 000 0000</span></li>" +
                  '<li data-placeholder>' + KT.icon("mail", 17) + "<span>hello@kandystreats.ng</span></li>" +
                  '<li data-placeholder>' + KT.icon("pin", 17) + "<span>Admiralty Way, Lekki Phase 1, Lagos</span></li>" +
                  '<li data-placeholder>' + KT.icon("clock", 17) + "<span>Mon–Sun, 8:00 AM – 10:00 PM</span></li>" +
                "</ul>" +
              "</div>" +
            "</div>" +
          "</div>" +

          '<div class="foot__notes">' +
            '<div class="foot__note"><strong>Delivery</strong><span>35–55 min average across Lekki, VI, Ikoyi, Yaba and Ikeja. Rider assigned the moment your food leaves the kitchen.</span></div>' +
            '<div class="foot__note"><strong>Pre-orders</strong><span>Party trays and celebration cakes need 24 hours\' notice. Place the order the day before by 6:00 PM.</span></div>' +
            '<div class="foot__note"><strong>Payment</strong><span>Card, bank transfer and cash on delivery. Payment options go live with the ordering release.</span></div>' +
          "</div>" +

          '<div class="foot__bar">' +
            "<p>© " + new Date().getFullYear() + " Kandy's Treats. All rights reserved.</p>" +
            '<ul class="foot__legal">' +
              '<li><a href="#" data-placeholder>Terms</a></li>' +
              '<li><a href="#" data-placeholder>Privacy</a></li>' +
              '<li><a href="#" data-placeholder>Refunds</a></li>' +
            "</ul>" +
          "</div>" +
        "</div>" +
      "</footer>";
  };
})(window.KT || (window.KT = {}));
