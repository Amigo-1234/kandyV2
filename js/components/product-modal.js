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
    var chosen = picked[group.id] || [];
    var opts = group.options
      .map(function (o) {
        var on = chosen.indexOf(o.id) > -1;
        return (
          '<label class="opt' + (on ? " is-on" : "") + '">' +
            '<input type="checkbox" name="' + group.id + '" value="' + o.id + '"' +
              (on ? " checked" : "") + ">" +
            '<span class="opt__mark">' + KT.icon("check", 13) + "</span>" +
            '<span class="opt__name">' + o.name + "</span>" +
            '<span class="opt__price">+' + KT.naira(o.price) + "</span>" +
          "</label>"
        );
      })
      .join("");

    return (
      '<fieldset class="optgroup" data-group="' + group.id + '">' +
        '<legend class="optgroup__head"><span>' + group.title + "</span>" +
          "<em>" + group.note + "</em></legend>" +
        '<div class="optgroup__list">' + opts + "</div>" +
      "</fieldset>"
    );
  }

  /**
   * Kandy's has no add-on system — proteins, sides and drinks are their own
   * menu items. These panels therefore list REAL items at REAL prices, and
   * every tick becomes its own basket line with its own menuId.
   */
  function optionsHTML(item, picked) {
    var groups = KT.menu.upsellsFor(item);
    if (!groups.length) {
      return '<p class="optnone">Ready as it comes — no extras needed.</p>';
    }
    return groups.map(function (g) { return optionGroup(g, picked); }).join("");
  }

  /** Every selected option id, flattened. */
  function selectedIds(picked) {
    return Object.keys(picked || {}).reduce(function (all, k) {
      return all.concat(picked[k] || []);
    }, []);
  }

  function priceOf(item, picked, n) {
    var extra = selectedIds(picked).reduce(function (sum, id) {
      var extraItem = KT.menu.byId(id);
      return sum + (extraItem ? extraItem.price : 0);
    }, 0);
    return (item.price + extra) * n;
  }

  /** Add the item plus each chosen extra as separate basket lines. */
  function addSelection(item, picked, n) {
    KT.cart.add(item.id, n);
    selectedIds(picked).forEach(function (id) { KT.cart.add(id, n); });
  }

  function readSelection(root) {
    var picked = {};
    KT.qsa("[data-group]", root).forEach(function (fs) {
      picked[fs.getAttribute("data-group")] = KT.qsa("input:checked", fs).map(function (i) {
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
        KT.images.picture(
          '<img data-food alt="" decoding="async" src="' +
            KT.images.src(item.image) + '">',
          item.image, "(max-width: 720px) 92vw, 420px") +
        '<span class="modal__tags">' + KT.components.tags(item, 3) + "</span>" +
      "</div>" +
      '<div class="modal__content">' +
        '<p class="eyebrow">' + KT.menu.category(item.category).name + "</p>" +
        '<h2 class="display-md" id="qlTitle">' + item.name + "</h2>" +
        '<div class="modal__meta">' +
          "<span>" + KT.naira(item.price) + "</span>" +
          '<span class="fcard__dot"></span><span>' + KT.icon("clock", 15) + "Cooked to order</span>" +
          (KT.menu.available(item) ? "" :
            '<span class="fcard__dot"></span><span class="tag tag--deal">Sold out today</span>') +
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
        /* Same rule as the product page: disabled, not just refused. */
        '<button class="btn btn--primary btn--lg modal__add" type="button" data-modal-add' +
          (KT.menu.available(item) ? "" : " disabled aria-disabled=\"true\"") + ">" +
          "<span>" + (KT.menu.available(item) ? "Add to basket" : "Sold out today") +
          "</span><span class=\"modal__addprice\" data-mprice>" +
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
      addSelection(current, selection, qty);
      KT.toast(current.name + (qty > 1 ? " ×" + qty : "") + " added", "success", {
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
    selection = {};
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
  KT.components.addSelection = addSelection;
})(window.KT || (window.KT = {}));
