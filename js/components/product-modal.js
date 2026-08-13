/* ==========================================================================
   Kandy's Treats — Quick-look product modal
   Opened from the menu grid so browsing is never interrupted. The full
   product page (pages/product.html) reuses the same option renderer.
   ========================================================================== */
(function (KT) {
  "use strict";

  var el = {};
  var current = null;
  var selection = {};
  var qty = 1;

  /* ---- Option groups (shared with the product page) ------------------ */

  function optionGroup(group, picked) {
    var opts = group.options
      .map(function (o) {
        var on = (picked[group.id] || []).indexOf(o.id) > -1;
        return (
          '<label class="opt' + (on ? " is-on" : "") + '">' +
            '<input type="' + (group.type === "single" ? "radio" : "checkbox") +
              '" name="' + group.id + '" value="' + o.id + '"' + (on ? " checked" : "") + ">" +
            '<span class="opt__mark">' + KT.icon("check", 13) + "</span>" +
            '<span class="opt__name">' + o.name + "</span>" +
            '<span class="opt__price">' + (o.price ? "+" + KT.naira(o.price) : "Free") + "</span>" +
          "</label>"
        );
      })
      .join("");

    return (
      '<fieldset class="optgroup" data-group="' + group.id + '">' +
        '<legend class="optgroup__head"><span>' + group.title + "</span>" +
          '<em>' + group.note + "</em></legend>" +
        '<div class="optgroup__list">' + opts + "</div>" +
      "</fieldset>"
    );
  }

  function optionsHTML(item, picked) {
    if (!item.addons || !item.addons.length) {
      return '<p class="optnone">No extras needed — this one comes ready.</p>';
    }
    return item.addons
      .map(function (g) {
        return optionGroup(g, picked);
      })
      .join("");
  }

  function priceOf(item, picked, n) {
    var extra = 0;
    (item.addons || []).forEach(function (g) {
      var chosen = picked[g.id] || [];
      g.options.forEach(function (o) {
        if (chosen.indexOf(o.id) > -1) extra += o.price;
      });
    });
    return (item.price + extra) * n;
  }

  function readSelection(root) {
    var picked = {};
    KT.qsa("[data-group]", root).forEach(function (fs) {
      var id = fs.getAttribute("data-group");
      picked[id] = KT.qsa("input:checked", fs).map(function (i) {
        return i.value;
      });
    });
    return picked;
  }

  /* ---- Modal --------------------------------------------------------- */

  function build() {
    var node = document.createElement("div");
    node.className = "modal";
    node.hidden = true;
    node.innerHTML =
      '<div class="modal__scrim" data-close-modal></div>' +
      '<div class="modal__panel" role="dialog" aria-modal="true" aria-labelledby="qlTitle">' +
        '<button class="modal__close icon-btn" type="button" data-close-modal aria-label="Close">' +
          KT.icon("close", 22) + "</button>" +
        '<div class="modal__grid" data-modal-body></div>' +
      "</div>";
    document.body.appendChild(node);
    el.root = node;
    el.body = KT.qs("[data-modal-body]", node);

    node.addEventListener("click", function (e) {
      if (e.target.closest("[data-close-modal]")) close();
    });
  }

  function render() {
    var item = current;
    el.body.innerHTML =
      '<div class="modal__media">' +
        '<img data-food alt="" src="' + KT.images.src(item.image, "square") + '">' +
        '<span class="modal__tags">' + KT.components.tags(item, 3) + "</span>" +
      "</div>" +
      '<div class="modal__content">' +
        '<p class="eyebrow">' + KT.menu.category(item.category).name + "</p>" +
        '<h2 class="display-md" id="qlTitle">' + item.name + "</h2>" +
        '<div class="modal__meta">' +
          '<span class="rating">' + KT.icon("star", 15) + item.rating.toFixed(1) +
            "<em>(" + item.reviews + " reviews)</em></span>" +
          '<span class="fcard__dot"></span><span>' + KT.icon("clock", 15) + item.prep + " min</span>" +
          (item.serves ? '<span class="fcard__dot"></span><span>' + item.serves + "</span>" : "") +
        "</div>" +
        '<p class="modal__desc">' + item.description + "</p>" +
        '<div class="modal__opts" data-opts>' + optionsHTML(item, selection) + "</div>" +
      "</div>" +
      '<div class="modal__bar">' +
        '<div class="stepper">' +
          '<button class="stepper__btn" type="button" data-mq="-1" aria-label="Decrease quantity">' + KT.icon("minus", 16) + "</button>" +
          '<span class="stepper__value" data-mqty>' + qty + "</span>" +
          '<button class="stepper__btn" type="button" data-mq="1" aria-label="Increase quantity">' + KT.icon("plus", 16) + "</button>" +
        "</div>" +
        '<button class="btn btn--primary btn--lg modal__add" type="button" data-modal-add>' +
          "<span>Add to basket</span><span class=\"modal__addprice\" data-mprice>" +
          KT.naira(priceOf(item, selection, qty)) + "</span></button>" +
        '<a class="modal__full" href="' + KT.url("pages/product.html?id=" + item.id) + '">Full details' +
          KT.icon("arrowRight", 15) + "</a>" +
      "</div>";

    KT.images.bindAll(el.body);
    wire();
  }

  function refreshPrice() {
    var p = KT.qs("[data-mprice]", el.body);
    if (p) p.textContent = KT.naira(priceOf(current, selection, qty));
  }

  function wire() {
    KT.qsa("[data-mq]", el.body).forEach(function (b) {
      b.addEventListener("click", function () {
        qty = Math.max(1, Math.min(20, qty + Number(b.getAttribute("data-mq"))));
        KT.qs("[data-mqty]", el.body).textContent = qty;
        refreshPrice();
      });
    });

    KT.qsa("[data-group] input", el.body).forEach(function (input) {
      input.addEventListener("change", function () {
        selection = readSelection(el.body);
        KT.qsa("[data-group] .opt", el.body).forEach(function (l) {
          l.classList.toggle("is-on", KT.qs("input", l).checked);
        });
        refreshPrice();
      });
    });

    KT.qs("[data-modal-add]", el.body).addEventListener("click", function () {
      KT.cart.add(current.id, qty, selection);
      KT.toast(KT.plural(qty, current.name.toLowerCase() + " added", current.name.toLowerCase() + " added"), "success", {
        action: "View basket",
        onAction: function () {
          KT.drawer.open();
        }
      });
      close();
    });
  }

  function open(itemId) {
    var item = KT.menu.byId(itemId);
    if (!item) return;
    if (!el.root) build();
    current = item;
    qty = 1;
    selection = KT.menu.defaultAddons(item);
    render();
    el.root.hidden = false;
    requestAnimationFrame(function () {
      el.root.classList.add("is-open");
    });
    KT.lockScroll(true);
  }

  function close() {
    if (!el.root) return;
    el.root.classList.remove("is-open");
    KT.lockScroll(false);
    setTimeout(function () {
      el.root.hidden = true;
    }, 280);
  }

  function init() {
    build();
    document.addEventListener("click", function (e) {
      var trigger = e.target.closest("[data-quicklook]");
      if (!trigger) return;
      e.preventDefault();
      open(trigger.getAttribute("data-quicklook"));
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && el.root && !el.root.hidden) close();
    });
  }

  KT.quicklook = { open: open, close: close, init: init };
  KT.components = KT.components || {};
  KT.components.optionsHTML = optionsHTML;
  KT.components.readSelection = readSelection;
  KT.components.priceOf = priceOf;
})(window.KT || (window.KT = {}));
