/* ==========================================================================
   Kandy's Treats — Product detail page
   Reads ?id= from the URL. Falls back to the bestseller if the id is unknown
   so the page is never blank.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.pages = KT.pages || {};

  var item, qty = 1, selection = {};

  /* The prototype has one photo per dish. Four crops of it stand in for a
     gallery — replace with real alternate shots in js/data/images.js. */
  var CROPS = ["detail", "square", "wide", "tall"];

  function galleryHTML() {
    return CROPS.map(function (p, i) {
      return (
        '<button class="pdp__thumb' + (i === 0 ? " is-active" : "") +
        '" type="button" data-crop="' + p + '" aria-label="View ' + (i + 1) + '">' +
        '<img data-food alt="" src="' + KT.images.src(item.image, "thumb") + '"></button>'
      );
    }).join("");
  }

  function priceNow() {
    return KT.components.priceOf(item, selection, qty);
  }

  function refreshPrice() {
    KT.qs("[data-pdp-price]").textContent = KT.naira(priceNow());
  }

  function render() {
    var cat = KT.menu.category(item.category);

    KT.mount(
      "[data-pdp]",
      '<nav class="crumbs" aria-label="Breadcrumb">' +
        '<a href="' + KT.url("index.html") + '">Home</a>' + KT.icon("chevronRight", 13) +
        '<a href="' + KT.url("pages/menu.html") + '">Menu</a>' + KT.icon("chevronRight", 13) +
        '<a href="' + KT.url("pages/menu.html?category=" + cat.id) + '">' + cat.name + "</a>" +
        KT.icon("chevronRight", 13) + "<strong>" + item.name + "</strong>" +
      "</nav>" +

      '<div class="pdp__grid">' +
        '<div class="pdp__media">' +
          '<div class="pdp__hero">' +
            '<img data-food data-pdp-hero alt="' + item.name + '" src="' +
              KT.images.src(item.image, "detail") + '">' +
            '<span class="pdp__herotags">' + KT.components.tags(item, 3) + "</span>" +
          "</div>" +
          '<div class="pdp__gallery">' + galleryHTML() + "</div>" +

          '<div class="pdp__info">' +
            '<div class="pdp__infocard"><span>' + KT.icon("clock", 18) + "</span>" +
              "<strong>" + item.prep + " min</strong><em>kitchen time</em></div>" +
            '<div class="pdp__infocard"><span>' + KT.icon("bike", 18) + "</span>" +
              "<strong>35–55 min</strong><em>to your door</em></div>" +
            '<div class="pdp__infocard"><span>' + KT.icon("star", 18) + "</span>" +
              "<strong>" + item.rating.toFixed(1) + "</strong><em>" + item.reviews + " reviews</em></div>" +
          "</div>" +
        "</div>" +

        '<div class="pdp__detail">' +
          '<p class="eyebrow">' + cat.name + (item.serves ? " · serves " + item.serves : "") + "</p>" +
          '<h1 class="display-lg pdp__title">' + item.name + "</h1>" +

          '<div class="pdp__meta">' +
            '<span class="rating">' + KT.icon("star", 16) + item.rating.toFixed(1) +
              "<em>(" + item.reviews + " reviews)</em></span>" +
            '<span class="fcard__dot"></span>' +
            "<span>" + KT.icon("clock", 16) + "Ready in " + item.prep + " min</span>" +
          "</div>" +

          '<p class="pdp__desc">' + item.description + "</p>" +

          '<div class="pdp__price">' +
            (item.was ? '<s class="price--strike">' + KT.naira(item.was) + "</s>" : "") +
            '<span class="price">' + KT.naira(item.price) + "</span>" +
            (item.was ? '<em class="promo__save">Save ' + KT.naira(item.was - item.price) + "</em>" : "") +
          "</div>" +

          '<div class="pdp__opts" data-pdp-opts>' +
            KT.components.optionsHTML(item, selection) +
          "</div>" +

          '<label class="field pdp__note">' +
            '<span class="field__label">Anything the kitchen should know?</span>' +
            '<textarea class="textarea" rows="3" placeholder="Less pepper, extra sauce on the side, call on arrival…"></textarea>' +
            '<span class="field__hint">Notes are visual only in this build — they will reach the kitchen once ordering is live.</span>' +
          "</label>" +

          '<div class="pdp__buybox">' +
            '<div class="stepper">' +
              '<button class="stepper__btn" type="button" data-pq="-1" aria-label="Decrease quantity">' +
                KT.icon("minus", 17) + "</button>" +
              '<span class="stepper__value" data-pqty>1</span>' +
              '<button class="stepper__btn" type="button" data-pq="1" aria-label="Increase quantity">' +
                KT.icon("plus", 17) + "</button>" +
            "</div>" +
            '<button class="btn btn--primary btn--lg pdp__add" type="button" data-pdp-add>' +
              "<span>Add to basket</span><span data-pdp-price>" + KT.naira(priceNow()) + "</span></button>" +
            '<button class="pdp__fav" type="button" data-fav aria-label="Save for later">' +
              KT.icon("heart", 20) + "</button>" +
          "</div>" +
        "</div>" +
      "</div>"
    );

    KT.images.bindAll(KT.qs("[data-pdp]"));
    related();
    wire();
  }

  function related() {
    var host = KT.qs("[data-pdp-related]");
    if (!host) return;
    var picks = KT.menu
      .byCategory(item.category)
      .filter(function (i) {
        return i.id !== item.id;
      })
      .slice(0, 4);
    if (picks.length < 4) {
      picks = picks.concat(
        KT.menu.trending(8).filter(function (i) {
          return i.id !== item.id && picks.indexOf(i) === -1;
        })
      ).slice(0, 4);
    }
    host.innerHTML = KT.components.foodCards(picks);
    KT.images.bindAll(host);
    KT.components.paintCards(host);
  }

  function wire() {
    var root = KT.qs("[data-pdp]");

    KT.qsa("[data-crop]", root).forEach(function (b) {
      b.addEventListener("click", function () {
        KT.qsa("[data-crop]", root).forEach(function (x) {
          x.classList.toggle("is-active", x === b);
        });
        var hero = KT.qs("[data-pdp-hero]", root);
        hero.style.opacity = "0";
        setTimeout(function () {
          hero.src = KT.images.src(item.image, b.getAttribute("data-crop"));
          hero.style.opacity = "1";
        }, 160);
      });
    });

    KT.qsa("[data-pq]", root).forEach(function (b) {
      b.addEventListener("click", function () {
        qty = Math.max(1, Math.min(20, qty + Number(b.getAttribute("data-pq"))));
        KT.qs("[data-pqty]", root).textContent = qty;
        refreshPrice();
      });
    });

    KT.qsa("[data-pdp-opts] input", root).forEach(function (input) {
      input.addEventListener("change", function () {
        selection = KT.components.readSelection(KT.qs("[data-pdp-opts]", root));
        KT.qsa("[data-pdp-opts] .opt", root).forEach(function (l) {
          l.classList.toggle("is-on", KT.qs("input", l).checked);
        });
        refreshPrice();
      });
    });

    KT.qs("[data-pdp-add]", root).addEventListener("click", function () {
      KT.cart.add(item.id, qty, selection);
      KT.toast(item.name + " × " + qty + " added", "success", {
        action: "View basket",
        onAction: function () {
          KT.drawer.open();
        }
      });
    });

    KT.qs("[data-fav]", root).addEventListener("click", function () {
      this.classList.toggle("is-on");
      KT.toast(
        this.classList.contains("is-on")
          ? "Saved — favourites arrive with accounts."
          : "Removed from saved items.",
        "info"
      );
    });
  }

  KT.pages.product = function () {
    var id = KT.param("id");
    item = KT.menu.byId(id) || KT.menu.trending(1)[0];
    selection = KT.menu.defaultAddons(item);
    qty = 1;
    document.title = item.name + " — Kandy's Treats";
    render();
  };
})(window.KT || (window.KT = {}));
