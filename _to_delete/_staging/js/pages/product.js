/* ==========================================================================
   Kandy's Treats — Product detail page
   Reads ?id= from the URL. Falls back to the bestseller if the id is unknown
   so the page is never blank.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.pages = KT.pages || {};

  var item, qty = 1, selection = {};

  /* Kandy's supplies one photograph per dish today, so there is no gallery to
     fake. When extra shots exist (menu.gallery from Firestore) the strip
     appears automatically; until then it stays hidden. */
  function galleryHTML() {
    var extra = (item.gallery || []).length;
    if (!extra) return "";
    return [item].concat((item.gallery || []).map(function (url) {
      return { imageUrl: url };
    })).map(function (shot, i) {
      return (
        '<button class="pdp__thumb' + (i === 0 ? " is-active" : "") +
        '" type="button" data-shot="' + i + '" aria-label="View photo ' + (i + 1) + '">' +
        '<img data-food alt="" src="' + KT.images.src(shot) + '"></button>'
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
              KT.images.src(item.image) + '">' +
            '<span class="pdp__herotags">' + KT.components.tags(item, 3) + "</span>" +
          "</div>" +
          '<div class="pdp__gallery">' + galleryHTML() + "</div>" +

          '<div class="pdp__info">' +
            '<div class="pdp__infocard"><span>' + KT.icon("bike", 18) + "</span>" +
              "<strong>" + KT.naira(KT.rules.DELIVERY_FEE) + "</strong><em>delivery, Lagos</em></div>" +
            '<div class="pdp__infocard"><span>' + KT.icon("clock", 18) + "</span>" +
              "<strong>~" + KT.rules.ETA_MINUTES.delivery + " min</strong><em>typical delivery</em></div>" +
            '<div class="pdp__infocard"><span>' + KT.icon("pin", 18) + "</span>" +
              "<strong>Pickup</strong><em>ready in ~" + KT.rules.ETA_MINUTES.pickup + " min</em></div>" +
          "</div>" +
        "</div>" +

        '<div class="pdp__detail">' +
          '<p class="eyebrow">' + cat.name + "</p>" +
          '<h1 class="display-lg pdp__title">' + item.name + "</h1>" +

          '<div class="pdp__meta">' +
            "<span>" + KT.icon("clock", 16) + "Cooked to order</span>" +
            '<span class="fcard__dot"></span>' +
            "<span>" + KT.icon("pin", 16) + KT.config.serviceArea.label + "</span>" +
            (KT.menu.available(item) ? "" :
              '<span class="fcard__dot"></span><span class="tag tag--deal">Sold out today</span>') +
          "</div>" +

          '<p class="pdp__desc">' + item.description + "</p>" +

          '<div class="pdp__price">' +
            '<span class="price">' + KT.naira(item.price) + "</span>" +
          "</div>" +

          '<div class="pdp__opts" data-pdp-opts>' +
            KT.components.optionsHTML(item, selection) +
          "</div>" +

          '<label class="field pdp__note">' +
            '<span class="field__label">Anything the kitchen should know?</span>' +
            '<textarea class="textarea" rows="3" placeholder="Less pepper, extra sauce on the side, call on arrival…"></textarea>' +
            '<span class="field__hint">Sent to the kitchen with your order.</span>' +
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
        KT.menu.featured(8).filter(function (i) {
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

    KT.qsa("[data-shot]", root).forEach(function (b) {
      b.addEventListener("click", function () {
        KT.qsa("[data-shot]", root).forEach(function (x) {
          x.classList.toggle("is-active", x === b);
        });
        var index = Number(b.getAttribute("data-shot"));
        var shot = index === 0 ? item : { imageUrl: (item.gallery || [])[index - 1] };
        var hero = KT.qs("[data-pdp-hero]", root);
        hero.style.opacity = "0";
        setTimeout(function () {
          hero.src = KT.images.src(shot);
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
      if (!KT.menu.available(item)) {
        KT.toast(item.name + " is sold out today.", "info");
        return;
      }
      var note = KT.qs(".pdp__note textarea", root);
      if (note && note.value.trim()) KT.cart.setNotes(note.value);
      KT.components.addSelection(item, selection, qty);
      KT.toast(item.name + (qty > 1 ? " ×" + qty : "") + " added", "success", {
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
          ? "Saved to your favourites."
          : "Removed from saved items.",
        "info"
      );
    });
  }

  KT.pages.product = function () {
    var id = KT.param("id");
    item = KT.menu.byId(id) || KT.menu.featured(1)[0];
    selection = {};
    qty = 1;
    document.title = item.name + " — Kandy's Treats";
    render();
  };
})(window.KT || (window.KT = {}));
