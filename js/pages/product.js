/* ==========================================================================
   Kandy's Treats — Product detail page
   Reads ?id= from the URL. Falls back to the bestseller if the id is unknown
   so the page is never blank.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.pages = KT.pages || {};

  var item, qty = 1, selection = {}, favourites = [];

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
        KT.images.picture(
          '<img data-food alt="" loading="lazy" decoding="async" src="' +
            KT.images.src(shot) + '">', shot, "86px") + "</button>"
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
            KT.images.picture(
              '<img data-food data-pdp-hero decoding="async" alt="' + item.name +
                '" src="' + KT.images.src(item.image) + '">',
              item.image, "(max-width: 900px) 94vw, 560px") +
            '<span class="pdp__herotags">' + KT.components.tags(item, 3) + "</span>" +
          "</div>" +
          '<div class="pdp__gallery">' + galleryHTML() + "</div>" +

          '<div class="pdp__info">' +
            '<div class="pdp__infocard"><span>' + KT.icon("bike", 18) + "</span>" +
              "<strong>" + KT.naira(KT.rules.DELIVERY_FEE) + "</strong><em>delivery, Ado-Ekiti/Iworoko</em></div>" +
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
            '<span data-pdp-rating></span>' +
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

    var fav = KT.qs("[data-fav]", root);
    fav.classList.toggle("is-on", favourites.indexOf(item.id) > -1);
    fav.addEventListener("click", async function () {
      if (!KT.services || !KT.auth.isSignedIn()) {
        KT.toast("Sign in to save favourites.", "info", {
          action: "Sign in",
          onAction: function () {
            window.location.href = KT.url("pages/login.html?next=account");
          }
        });
        return;
      }
      fav.disabled = true;
      try {
        var on = await KT.services.account.toggleFavourite(item.id);
        fav.classList.toggle("is-on", on);
        favourites = on
          ? favourites.concat([item.id])
          : favourites.filter(function (id) { return id !== item.id; });
        KT.toast(on ? "Saved to your favourites." : "Removed from favourites.", "info");
      } catch (error) {
        KT.toast(KT.services.errorMessage(error), "error");
      } finally {
        fav.disabled = false;
      }
    });
  }

  /* A stale or mistyped link must not quietly become a different dish at a
     different price. Say the item is gone and offer the menu instead. */
  function notFound() {
    var host = KT.qs("[data-pdp]") || KT.qs("main") || document.body;
    document.title = "Dish not found — Kandy's Treats";
    KT.mount(host,
      '<div class="panel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("search", 38) + "</div>" +
        "<h3>We could not find that dish</h3>" +
        "<p>It may have come off the menu, or the link may be out of date.</p>" +
        '<a class="btn btn--primary" href="' + KT.url("pages/menu.html") +
          '">Browse the full menu</a>' +
      "</div></div>");
  }

  KT.pages.product = function () {
    var id = KT.param("id");
    item = KT.menu.byId(id);

    if (!item) {
      /* The live menu may not have arrived yet, so wait for it before
         concluding the dish is really gone. */
      if (!KT.menu.live) {
        document.addEventListener("kt:menu", function once() {
          document.removeEventListener("kt:menu", once);
          if (KT.menu.byId(id)) KT.pages.product();
          else notFound();
        });
        KT.mount(KT.qs("[data-pdp]") || KT.qs("main") || document.body,
          KT.loadingLabel("Loading this dish…") + KT.skeleton.panel(5));
        return;
      }
      notFound();
      return;
    }

    selection = {};
    qty = 1;
    document.title = item.name + " — Kandy's Treats";
    render();

    /* Real customer ratings, if this dish has any yet. */
    function loadReviews() {
      if (!KT.services) return;
      KT.services.reviews.forItem(item.id).then(function (result) {
        var slot = KT.qs("[data-pdp-rating]");
        if (!slot || !result.count) return;
        slot.innerHTML = '<span class="fcard__dot"></span>' +
          '<span class="rating">' + KT.icon("star", 16) + result.average.toFixed(1) +
          "<em>(" + KT.plural(result.count, "rating") + ")</em></span>";
      }).catch(function () {});
    }
    document.addEventListener("kt:services", loadReviews);
    loadReviews();

    /* Reflect the customer's saved items on the heart. */
    function loadFavourites() {
      if (!KT.services || !KT.auth.isSignedIn()) return;
      KT.services.account.favourites().then(function (list) {
        favourites = list || [];
        var fav = KT.qs("[data-fav]");
        if (fav) fav.classList.toggle("is-on", favourites.indexOf(item.id) > -1);
      }).catch(function () {});
    }
    document.addEventListener("kt:auth", loadFavourites);
    loadFavourites();

    /* Re-resolve against the live menu so price and availability are real. */
    document.addEventListener("kt:menu", KT.debounce(function () {
      var fresh = KT.menu.byId(id);
      if (!fresh) return;
      item = fresh;
      document.title = item.name + " — Kandy's Treats";
      render();
    }, 60));
  };
})(window.KT || (window.KT = {}));
