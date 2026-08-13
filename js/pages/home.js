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
    if (plate) plate.src = KT.images.src("hero-plate", "hero");

    /* Two small cards orbiting the plate, drawn from real menu data. */
    var picks = [KT.menu.byId("meat-pie"), KT.menu.byId("berry-smoothie")];
    KT.qsa("[data-hero-card]").forEach(function (node, i) {
      var item = picks[i];
      if (!item) return;
      node.innerHTML =
        '<span class="ring herocard__ring"><img data-food alt="" src="' +
          KT.images.src(item.image, "thumb") + '"></span>' +
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
      var words = ["jollof", "small chops", "meat pies", "chapman", "cupcakes"];
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
            '<span class="cattile__ring ring"><img data-food alt="" src="' +
              KT.images.src(c.image, "thumb") + '"></span>' +
            '<span class="cattile__name">' + c.name + "</span>" +
            '<span class="cattile__blurb">' + c.blurb + "</span>" +
            '<span class="cattile__count">' + n + " items" + KT.icon("arrowRight", 14) + "</span>" +
          "</a>"
        );
      })
      .join("");
  }

  /* ---- Trending -------------------------------------------------------- */

  function trending() {
    var host = KT.qs("[data-trending]");
    if (!host) return;
    var picks = KT.menu.trending(7);
    host.innerHTML =
      KT.components.foodCard(picks[0], "feature") +
      KT.components.foodCards(picks.slice(1, 5));

    var rail = KT.qs("[data-trending-rail]");
    if (rail) rail.innerHTML = KT.components.foodCards(KT.menu.tagged("new").concat(picks.slice(5)));
  }

  /* ---- Promo band ------------------------------------------------------ */

  function promo() {
    var host = KT.qs("[data-promo]");
    if (!host) return;
    var item = KT.menu.byId("owanbe-pack");
    var save = item.was - item.price;

    host.innerHTML =
      '<div class="promo__media" data-parallax="0.5">' +
        '<img data-food alt="" src="' + KT.images.src(item.image, "wide") + '">' +
      "</div>" +
      '<div class="promo__body">' +
        '<p class="eyebrow eyebrow--light">Feeding a crowd</p>' +
        '<h2 class="display-lg">' + item.name + "</h2>" +
        '<p class="promo__desc">' + item.description + "</p>" +
        '<ul class="promo__list">' +
          ["Party jollof &amp; coconut fried rice", "Six pieces of grilled chicken",
            "Full small chops tray", "Five chilled drinks"]
            .map(function (t) {
              return "<li>" + KT.icon("check", 15) + t + "</li>";
            })
            .join("") +
        "</ul>" +
        '<div class="promo__buy">' +
          '<div class="promo__price"><s class="price--strike">' + KT.naira(item.was) +
            '</s><span class="price price--lg">' + KT.naira(item.price) + "</span>" +
            '<em class="promo__save">Save ' + KT.naira(save) + "</em></div>" +
          '<button class="btn btn--onDark btn--lg" type="button" data-add="' + item.id + '">' +
            "Add the party pack" + KT.icon("arrowRight", 18) + "</button>" +
        "</div>" +
        '<p class="promo__fine">Serves 5 · 24 hours\' notice · Lagos delivery only</p>' +
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
                '<img data-food alt="" src="' + KT.images.src(item.image, "thumb") + '"></a>' +
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

  KT.pages.home = function () {
    hero();
    categories();
    trending();
    promo();
    discovery();
  };
})(window.KT || (window.KT = {}));
