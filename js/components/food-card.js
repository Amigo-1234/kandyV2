/* ==========================================================================
   Kandy's Treats — Food card
   --------------------------------------------------------------------------
   Three variants share one markup contract:
     default  vertical card, used in grids and rails
     feature  taller hero card for the lead slot of the trending grid
     row      horizontal compact card, used in dense mobile lists

   The add control is the centre of gravity: a circular pink button that sits
   over the photo, then morphs in place into a quantity stepper once the item
   is in the basket. Nothing jumps, nothing re-flows.
   ========================================================================== */
(function (KT) {
  "use strict";

  /* Only tags we can actually derive from the menu document. Nothing here is
     invented — `quick-pick` comes from the admin-curated quickPicks
     collection, `sold-out` and `alcohol` from the item itself. */
  var TAG_META = {
    "quick-pick": ["tag--new", "star", "Quick pick"],
    "sold-out": ["tag--deal", "close", "Sold out"],
    alcohol: ["tag--hot", "flame", "18+"]
  };

  /* Honest, category-level facts for the card's metadata row. */
  var CATEGORY_HINT = {
    foods: "Cooked to order",
    proteins: "Cooked to order",
    specials: "Cooked to order",
    soups: "Cooked to order",
    shawarma: "Rolled to order",
    sides: "Made fresh",
    drinks: "Served chilled"
  };

  function tags(item, max) {
    var list = (item.tags || []).slice();
    if (!KT.menu.available(item) && list.indexOf("sold-out") === -1) list.unshift("sold-out");
    return list
      .slice(0, max || 2)
      .map(function (t) {
        var m = TAG_META[t];
        if (!m) return "";
        return '<span class="tag ' + m[0] + '">' + KT.icon(m[1], 13) + m[2] + "</span>";
      })
      .join("");
  }

  function priceBlock(item) {
    return '<span class="fcard__price"><span>' + KT.naira(item.price) + "</span></span>";
  }

  /**
   * @param {object} item   menu item
   * @param {string} variant '' | 'feature' | 'row'
   */
  function card(item, variant) {
    /* Callers build whole grids from this. One absent item is a gap, not a
       reason for the rest of the page to stop rendering. */
    if (!item || !item.id) return "";
    variant = variant || "";
    var href = KT.url("pages/product.html?id=" + item.id);
    var cls = "fcard" + (variant ? " fcard--" + variant : "");

    var media =
      '<a class="fcard__media" href="' + href + '" tabindex="-1" aria-hidden="true">' +
        '<img data-food class="fcard__img" loading="lazy" alt="" src="' +
          KT.images.src(item) + '">' +
        '<span class="fcard__shade"></span>' +
        (variant !== "row" ? '<span class="fcard__tags">' + tags(item) + "</span>" : "") +
        (variant !== "row" ? priceBlock(item) : "") +
      "</a>" +
      (variant !== "row"
        ? '<button class="fcard__peek" type="button" data-quicklook="' + item.id +
          '" aria-label="Quick look at ' + item.name + '">' + KT.icon("eye", 17) +
          "<span>Quick look</span></button>"
        : "");

    var cat = KT.menu.category(item.category);
    var meta =
      '<div class="fcard__meta">' +
        "<span>" + (cat ? cat.name : item.section || "") + "</span>" +
        '<span class="fcard__dot"></span>' +
        "<span>" + KT.icon("clock", 14) +
          (CATEGORY_HINT[item.category] || "Made to order") + "</span>" +
        (item.rating
          ? '<span class="fcard__dot"></span><span class="rating">' +
            KT.icon("star", 14) + Number(item.rating).toFixed(1) + "</span>"
          : "") +
      "</div>";

    var action =
      '<div class="fcard__action" data-action>' +
        '<button class="fcard__add" type="button" data-add="' + item.id + '" aria-label="Add ' +
          item.name + ' to cart">' + KT.icon("plus", 20) + "</button>" +
      "</div>";

    if (variant === "row") {
      return (
        '<article class="' + cls + '" data-card="' + item.id + '">' +
          media +
          '<div class="fcard__body">' +
            '<h3 class="fcard__name"><a href="' + href + '">' + item.name + "</a></h3>" +
            '<p class="fcard__blurb">' + item.blurb + "</p>" +
            meta +
            '<div class="fcard__foot">' + priceBlock(item) + action + "</div>" +
          "</div>" +
        "</article>"
      );
    }

    /* media + action share a wrapper so the add button can anchor to the
       bottom edge of the photo regardless of how tall the body grows */
    return (
      '<article class="' + cls + '" data-card="' + item.id + '">' +
        '<div class="fcard__top">' + media + action + "</div>" +
        '<div class="fcard__body">' +
          '<h3 class="fcard__name"><a href="' + href + '">' + item.name + "</a></h3>" +
          '<p class="fcard__blurb">' + item.blurb + "</p>" +
          meta +
        "</div>" +
      "</article>"
    );
  }

  /* ---- Add / stepper behaviour --------------------------------------- */

  function stepperHTML(itemId, qty) {
    return (
      '<div class="fcard__stepper" data-stepper>' +
        '<button type="button" data-dec="' + itemId + '" aria-label="Remove one">' +
          KT.icon("minus", 17) + "</button>" +
        '<span data-qty aria-live="polite">' + qty + "</span>" +
        '<button type="button" data-inc="' + itemId + '" aria-label="Add one">' +
          KT.icon("plus", 17) + "</button>" +
      "</div>"
    );
  }


  function paint(root) {
    KT.qsa("[data-card]", root).forEach(function (el) {
      var id = el.getAttribute("data-card");
      var host = KT.qs("[data-action]", el);
      if (!host) return;
      var qty = KT.cart.qtyOf(id);
      var hasStepper = !!KT.qs("[data-stepper]", host);

      if (qty > 0 && !hasStepper) {
        host.innerHTML = stepperHTML(id, qty);
        host.classList.add("is-open");
      } else if (qty > 0) {
        KT.qs("[data-qty]", host).textContent = qty;
      } else if (hasStepper) {
        host.classList.remove("is-open");
        host.innerHTML =
          '<button class="fcard__add" type="button" data-add="' + id +
          '" aria-label="Add to cart">' + KT.icon("plus", 20) + "</button>";
      }
      el.classList.toggle("in-cart", qty > 0);
    });
  }

  /** Little photo that flies from the card into the cart button. */
  function flyToCart(cardEl) {
    if (KT.prefersReducedMotion) return;
    var img = KT.qs(".fcard__img", cardEl);
    var target = KT.qs("[data-open-cart]") || KT.qs("[data-tab-cart]");
    if (!img || !target) return;

    var from = img.getBoundingClientRect();
    var to = target.getBoundingClientRect();
    var ghost = document.createElement("div");
    ghost.className = "fly-ghost";
    ghost.style.cssText =
      "left:" + from.left + "px;top:" + from.top + "px;width:" + from.width +
      "px;height:" + from.height + "px;background-image:url(" + img.currentSrc + ")";
    document.body.appendChild(ghost);

    requestAnimationFrame(function () {
      ghost.style.transform =
        "translate(" + (to.left + to.width / 2 - from.left - from.width / 2) + "px," +
        (to.top + to.height / 2 - from.top - from.height / 2) + "px) scale(0.12)";
      ghost.style.opacity = "0.25";
      ghost.style.borderRadius = "50%";
    });
    setTimeout(function () {
      ghost.remove();
      target.classList.add("is-bumped");
      setTimeout(function () {
        target.classList.remove("is-bumped");
      }, 420);
    }, 620);
  }

  /* Single delegated listener covers every card on the page, including any
     rendered after this point. */
  function bind() {
    if (bind.done) return;
    bind.done = true;

    document.addEventListener("click", function (e) {
      var add = e.target.closest("[data-add]");
      var inc = e.target.closest("[data-inc]");
      var dec = e.target.closest("[data-dec]");
      if (!add && !inc && !dec) return;

      var btn = add || inc || dec;
      var id = btn.getAttribute("data-add") || btn.getAttribute("data-inc") ||
        btn.getAttribute("data-dec");
      var item = KT.menu.byId(id);
      if (!item) return;
      e.preventDefault();

      var cardEl = btn.closest("[data-card]");

      if (!KT.menu.available(item)) {
        KT.toast(item.name + " is sold out today.", "info");
        return;
      }

      if (add || inc) {
        KT.cart.add(id, 1);
        if (add) {
          if (cardEl) flyToCart(cardEl);
          KT.toast(item.name + " added", "success", {
            action: "View cart",
            onAction: function () {
              KT.drawer.open();
            }
          });
        }
      } else {
        KT.cart.bump(id, -1);
      }
    });

    KT.cart.subscribe(function () {
      paint(document);
    });
  }

  KT.components = KT.components || {};
  KT.components.tags = tags;
  KT.components.foodCard = card;
  KT.components.foodCards = function (items, variant) {
    return items
      .map(function (i) {
        return card(i, variant);
      })
      .join("");
  };
  KT.components.paintCards = paint;
  KT.components.bindCards = bind;
})(window.KT || (window.KT = {}));
