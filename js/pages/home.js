/* ==========================================================================
   Kandy's Treats — Homepage
   Populates the dynamic regions of index.html from the menu data.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.pages = KT.pages || {};

  /* ---- Hero: floating cards + search ---------------------------------- */

  function hero() {
    var plate = KT.qs("[data-hero-plate]");
    if (plate) plate.src = KT.images.src("hero-plate");

    /* Two small cards orbiting the plate, drawn from real menu data. */
    var picks = [KT.menu.byId("meat-pie"), KT.menu.byId("peppered-gizzard")];
    KT.qsa("[data-hero-card]").forEach(function (node, i) {
      var item = picks[i];
      if (!item) return;
      node.innerHTML =
        '<span class="ring herocard__ring"><img data-food alt="" src="' +
          KT.images.src(item.image) + '"></span>' +
        '<span class="herocard__text"><strong>' + item.name + "</strong>" +
        "<em>" + KT.naira(item.price) + "</em></span>";
      node.setAttribute("href", KT.url("pages/product.html?id=" + item.id));
    });

    /* Hero search hands off to the menu page with the query pre-filled. */
    var form = KT.qs("[data-hero-search]");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var q = KT.qs("input", form).value.trim();
        window.location.href =
          KT.url("pages/menu.html") + (q ? "?q=" + encodeURIComponent(q) : "");
      });
    }

    /* Rotating word in the headline — subtle, pauses on reduced motion. */
    var rotator = KT.qs("[data-rotate]");
    if (rotator && !KT.prefersReducedMotion) {
      var words = ["jollof", "shawarma", "peppered gizzard", "chicken & chips", "parfait"];
      var i = 0;
      setInterval(function () {
        i = (i + 1) % words.length;
        rotator.classList.add("is-out");
        setTimeout(function () {
          rotator.textContent = words[i];
          rotator.classList.remove("is-out");
        }, 260);
      }, 2600);
    }
  }

  /* ---- Categories ------------------------------------------------------ */

  function categories() {
    var host = KT.qs("[data-categories]");
    if (!host) return;
    host.innerHTML = KT.menu.categories
      .map(function (c) {
        var n = KT.menu.byCategory(c.id).length;
        return (
          '<a class="cattile" href="' + KT.url("pages/menu.html?category=" + c.id) + '">' +
            '<span class="cattile__ring ring">' + KT.images.picture(
              '<img data-food alt="" loading="lazy" decoding="async" src="' +
                KT.images.src(c.image) + '">', c.image, "96px") + "</span>" +
            '<span class="cattile__name">' + c.name + "</span>" +
            '<span class="cattile__blurb">' + c.blurb + "</span>" +
            '<span class="cattile__count">' + n + " items" + KT.icon("arrowRight", 14) + "</span>" +
          "</a>"
        );
      })
      .join("");
  }

  /* ---- Trending -------------------------------------------------------- */

  function featured() {
    var host = KT.qs("[data-trending]");
    if (!host) return;
    var picks = KT.menu.featured(7);
    if (!picks.length) return;
    host.innerHTML =
      KT.components.foodCard(picks[0], "feature") +
      KT.components.foodCards(picks.slice(1, 5));

    var rail = KT.qs("[data-trending-rail]");
    if (rail) rail.innerHTML = KT.components.foodCards(KT.menu.byCategory("shawarma").concat(picks.slice(5)));
  }

  /* ---- Promo band ------------------------------------------------------ */

  function promo() {
    var host = KT.qs("[data-promo]");
    if (!host) return;

    /* KANDY10 is a real coupon enforced by functions/index.js — the numbers
       below come straight from KT.rules, so they cannot drift from the
       server's discount calculation. */
    var coupon = KT.rules.COUPONS.KANDY10;
    var welcome = KT.rules.COUPONS.WELCOME5;
    var hero = KT.menu.byId("chicken-and-chips") || KT.menu.featured(1)[0];
    var example = coupon.minSubtotal;
    var saving = KT.rules.couponDiscount(coupon, example);

    host.innerHTML =
      '<div class="promo__media" data-parallax="0.5">' +
        KT.images.picture(
          '<img data-food alt="" loading="lazy" decoding="async" src="' +
            KT.images.src(hero) + '">', hero, "(max-width: 900px) 96vw, 620px") +
      "</div>" +
      '<div class="promo__body">' +
        '<p class="eyebrow eyebrow--light">Use code ' + coupon.code + '</p>' +
        '<h2 class="display-lg">' + coupon.value + '% off when you spend ' +
          KT.naira(coupon.minSubtotal) + '</h2>' +
        '<p class="promo__desc">Build your plate past ' + KT.naira(coupon.minSubtotal) +
          " and " + coupon.code + " takes " + coupon.value +
          "% straight off the subtotal. Enter it in the basket — it applies before delivery and packaging.</p>" +
        '<ul class="promo__list">' +
          ["Works on every section of the menu",
            welcome.code + ": " + welcome.value + "% off over " + KT.naira(welcome.minSubtotal),
            "Flat " + KT.naira(KT.rules.DELIVERY_FEE) + " delivery across Ado-Ekiti/Iworoko",
            "Or collect it yourself — pickup is free"]
            .map(function (t2) { return "<li>" + KT.icon("check", 15) + t2 + "</li>"; })
            .join("") +
        "</ul>" +
        '<div class="promo__buy">' +
          '<div class="promo__price"><span class="price price--lg">' + coupon.code + "</span>" +
            '<em class="promo__save">Saves ' + KT.naira(saving) + " on a " +
              KT.naira(example) + " order</em></div>" +
          '<a class="btn btn--onDark btn--lg" href="' + KT.url("pages/menu.html") + '">' +
            "Start your order" + KT.icon("arrowRight", 18) + "</a>" +
        "</div>" +
        '<p class="promo__fine">One code per order · discount applies to the subtotal before fees</p>' +
      "</div>";
  }

  /* ---- Discovery: tabbed menu preview ---------------------------------- */

  function discovery() {
    var tabsHost = KT.qs("[data-discover-tabs]");
    var listHost = KT.qs("[data-discover-list]");
    if (!tabsHost || !listHost) return;

    var cats = KT.menu.categories;
    var activeId = cats[0].id;

    tabsHost.innerHTML = cats
      .map(function (c, i) {
        return (
          '<button class="chip' + (i === 0 ? " is-active" : "") + '" type="button" data-dtab="' +
          c.id + '" aria-pressed="' + (i === 0) + '">' + c.name + "</button>"
        );
      })
      .join("");

    function paint() {
      var items = KT.menu.byCategory(activeId).slice(0, 5);
      listHost.innerHTML = items
        .map(function (item) {
          return (
            '<li class="drow">' +
              '<a class="drow__media ring" href="' + KT.url("pages/product.html?id=" + item.id) + '">' +
                KT.images.picture(
                  '<img data-food alt="" loading="lazy" decoding="async" src="' +
                    KT.images.src(item.image) + '">',
                  item.image, "(max-width: 640px) 40vw, 200px") + "</a>" +
              '<div class="drow__text">' +
                '<h4><a href="' + KT.url("pages/product.html?id=" + item.id) + '">' + item.name + "</a></h4>" +
                "<p>" + item.blurb + "</p>" +
              "</div>" +
              '<div class="drow__right">' +
                '<span class="price">' + KT.naira(item.price) + "</span>" +
                '<button class="drow__add" type="button" data-quicklook="' + item.id + '">' +
                  KT.icon("plus", 18) + '<span class="sr-only">Quick look at ' + item.name + "</span></button>" +
              "</div>" +
            "</li>"
          );
        })
        .join("");
      KT.images.bindAll(listHost);
    }

    tabsHost.addEventListener("click", function (e) {
      var b = e.target.closest("[data-dtab]");
      if (!b) return;
      activeId = b.getAttribute("data-dtab");
      KT.qsa("[data-dtab]", tabsHost).forEach(function (x) {
        var on = x === b;
        x.classList.toggle("is-active", on);
        x.setAttribute("aria-pressed", on);
      });
      listHost.classList.add("is-swapping");
      setTimeout(function () {
        paint();
        listHost.classList.remove("is-swapping");
      }, 140);
    });

    paint();
  }

  function paintAll() {
    hero();
    categories();
    featured();
    promo();
    discovery();
    KT.components.paintCards(document);
    KT.images.bindAll(document);
    KT.motion.reveal();
  }

  KT.pages.home = function () {
    paintAll();
    /* The snapshot paints instantly; repaint once Firestore answers so live
       prices and sold-out states are what the customer actually sees. */
    document.addEventListener("kt:menu", KT.debounce(paintAll, 60));
  };
})(window.KT || (window.KT = {}));
