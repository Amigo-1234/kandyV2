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

  var TAG_META = {
    hot: ["tag--hot", "flame", "Spicy"],
    new: ["tag--new", "sparkle", "New"],
    veg: ["tag--veg", "leaf", "Veg"],
    deal: ["tag--deal", "gift", "Deal"],
    bestseller: ["tag--new", "star", "Bestseller"]
  };

  function tags(item, max) {
    return (item.tags || [])
      .slice(0, max || 2)
      .map(function (t) {
        var m = TAG_META[t];
        if (!m) return "";
        return '<span class="tag ' + m[0] + '">' + KT.icon(m[1], 13) + m[2] + "</span>";
      })
      .join("");
  }

  function priceBlock(item) {
    return (
      '<span class="fcard__price">' +
      (item.was ? '<s class="price--strike">' + KT.naira(item.was) + "</s>" : "") +
      "<span>" + KT.naira(item.price) + "</span></span>"
    );
  }

  function preset(variant) {
    return variant === "feature" ? "tall" : variant === "row" ? "thumb" : "card";
  }

  /**
   * @param {object} item   menu item
   * @param {string} variant '' | 'feature' | 'row'
   */
  function card(item, variant) {
    variant = variant || "";
    var href = KT.url("pages/product.html?id=" + item.id);
    var cls = "fcard" + (variant ? " fcard--" + variant : "");

    var media =
      '<a class="fcard__media" href="' + href + '" tabindex="-1" aria-hidden="true">' +
        '<img data-food class="fcard__img" loading="lazy" alt="" src="' +
          KT.images.src(item.image, preset(variant)) + '">' +
        '<span class="fcard__shade"></span>' +
        (variant !== "row" ? '<span class="fcard__tags">' + tags(item) + "</span>" : "") +
        (variant !== "row" ? priceBlock(item) : "") +
      "</a>" +
      (variant !== "row"
        ? '<button class="fcard__peek" type="button" data-quicklook="' + item.id +
          '" aria-label="Quick look at ' + item.name + '">' + KT.icon("eye", 17) +
          "<span>Quick look</span></button>"
        : "");

    var meta =
      '<div class="fcard__meta">' +
        '<span class="rating">' + KT.icon("star", 14) + item.rating.toFixed(1) +
          '<em>(' + item.reviews + ")</em></span>" +
        '<span class="fcard__dot"></span>' +
        "<span>" + KT.icon("clock", 14) + item.prep + " min</span>" +
        (item.serves ? '<span class="fcard__dot"></span><span>' + item.serves + "</span>" : "") +
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

  function qtyInCart(itemId) {
    return KT.cart.lines().reduce(function (n, l) {
      return l.itemId === itemId ? n + l.qty : n;
    }, 0);
  }

  /** First cart line matching this item (cards use default add-ons). */
  function keyFor(itemId) {
    var line = KT.cart.lines().filter(function (l) {
      return l.itemId === itemId;
    })[0];
    return line && line.key;
  }

  function paint(root) {
    KT.qsa("[data-card]", root).forEach(function (el) {
      var id = el.getAttribute("data-card");
      var host = KT.qs("[data-action]", el);
      if (!host) return;
      var qty = qtyInCart(id);
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
        var key = keyFor(id);
        if (key) KT.cart.bump(key, -1);
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
