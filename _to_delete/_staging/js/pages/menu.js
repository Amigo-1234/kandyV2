/* ==========================================================================
   Kandy's Treats — Menu page
   Category rail, search, filters, sort, grid/list view. All client-side and
   driven by js/data/menu.js.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.pages = KT.pages || {};

  var state = {
    category: "all",
    q: "",
    filters: [], // hot | veg | new | deal
    sort: "popular",
    view: "grid"
  };

  /* Only filters we can derive from real menu documents. */
  var FILTERS = [
    ["quick-pick", "Kitchen favourites", "star"],
    ["available", "In stock today", "check"],
    ["under-1000", "Under ₦1,000", "wallet"]
  ];

  var SORTS = [
    ["popular", "Kitchen favourites"],
    ["price-asc", "Price: low to high"],
    ["price-desc", "Price: high to low"],
    ["name", "Name: A to Z"]
  ];

  /* ---- Rendering ------------------------------------------------------ */

  function catRail() {
    var host = KT.qs("[data-menu-cats]");
    var all =
      '<button class="chip' + (state.category === "all" ? " is-active" : "") +
      '" type="button" data-cat="all">All items</button>';

    host.innerHTML =
      all +
      KT.menu.categories
        .map(function (c) {
          return (
            '<button class="chip' + (state.category === c.id ? " is-active" : "") +
            '" type="button" data-cat="' + c.id + '">' +
            '<img data-food alt="" src="' + KT.images.src(c.image) + '">' +
            c.name + "</button>"
          );
        })
        .join("");
    KT.images.bindAll(host);
  }

  function filterRow() {
    var host = KT.qs("[data-menu-filters]");
    host.innerHTML = FILTERS.map(function (f) {
      var on = state.filters.indexOf(f[0]) > -1;
      return (
        '<button class="chip' + (on ? " is-active" : "") + '" type="button" data-filter="' +
        f[0] + '" aria-pressed="' + on + '">' + KT.icon(f[2], 14) + f[1] + "</button>"
      );
    }).join("");
  }

  function jumpList() {
    var host = KT.qs("[data-menu-jump]");
    if (!host) return;
    host.innerHTML = KT.menu.categories
      .map(function (c) {
        return (
          '<a href="#cat-' + c.id + '" data-jump="' + c.id + '">' + c.name +
          "<em>" + KT.menu.byCategory(c.id).length + "</em></a>"
        );
      })
      .join("");
  }

  function results() {
    var items = KT.menu.byCategory(state.category);

    if (state.q) {
      var hits = KT.menu.search(state.q);
      items = items.filter(function (i) {
        return hits.indexOf(i) > -1;
      });
    }

    if (state.filters.length) {
      items = items.filter(function (i) {
        return state.filters.every(function (f) {
          if (f === "available") return KT.menu.available(i);
          if (f === "under-1000") return i.price < 1000;
          return (i.tags || []).indexOf(f) > -1;
        });
      });
    }

    var featured = KT.menu.featured(12).map(function (i) { return i.id; });
    var sorters = {
      /* Admin-curated quick picks first, then menu order. */
      popular: function (a, b) {
        var ia = featured.indexOf(a.id), ib = featured.indexOf(b.id);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      },
      "price-asc": function (a, b) { return a.price - b.price; },
      "price-desc": function (a, b) { return b.price - a.price; },
      name: function (a, b) { return a.name.localeCompare(b.name); }
    };
    items = items.slice().sort(sorters[state.sort]);

    var host = KT.qs("[data-menu-results]");
    var countHost = KT.qs("[data-menu-count]");

    countHost.innerHTML = items.length
      ? "<strong>" + items.length + "</strong> " +
        (items.length === 1 ? "item" : "items") +
        (state.q ? ' matching "<strong>' + escapeHtml(state.q) + "</strong>\"" : "") +
        (state.category !== "all"
          ? " in <strong>" + KT.menu.category(state.category).name + "</strong>"
          : "")
      : "";

    if (!items.length) {
      host.innerHTML =
        '<div class="empty">' +
          '<div class="empty__art">' + KT.icon("search", 38) + "</div>" +
          "<h3>Nothing matches that yet</h3>" +
          "<p>Try a different word, or clear the filters to see the whole menu.</p>" +
          '<button class="btn btn--soft" type="button" data-reset>Clear filters</button>' +
        "</div>";
      return;
    }

    var variant = state.view === "list" ? "row" : "";

    /* Grouped by category when browsing everything unfiltered. */
    if (state.category === "all" && !state.q && !state.filters.length) {
      host.innerHTML = KT.menu.categories
        .map(function (c) {
          var group = items.filter(function (i) {
            return i.category === c.id;
          });
          if (!group.length) return "";
          return (
            '<section class="menu__group" id="cat-' + c.id + '">' +
              '<div class="menu__grouphead"><h2>' + c.name + "</h2><em>" +
                group.length + " items · " + c.blurb + "</em></div>" +
              '<div class="cardgrid menu__grid' + (variant ? " is-list" : "") +
                '" data-reveal-group>' + KT.components.foodCards(group, variant) + "</div>" +
            "</section>"
          );
        })
        .join("");
    } else {
      host.innerHTML =
        '<div class="cardgrid menu__grid' + (variant ? " is-list" : "") +
        '" data-reveal-group>' + KT.components.foodCards(items, variant) + "</div>";
    }

    KT.images.bindAll(host);
    KT.components.paintCards(host);
    KT.motion.reveal();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function syncUrl() {
    var p = new URLSearchParams();
    if (state.category !== "all") p.set("category", state.category);
    if (state.q) p.set("q", state.q);
    if (state.filters.length) p.set("filter", state.filters.join(","));
    var qs = p.toString();
    history.replaceState(null, "", qs ? "?" + qs : location.pathname);
  }

  function refresh() {
    catRail();
    filterRow();
    results();
    syncUrl();
  }

  /* ---- Wiring --------------------------------------------------------- */

  KT.pages.menu = function () {
    /* Read incoming query string */
    state.category = KT.param("category") || "all";
    state.q = KT.param("q") || "";
    var f = KT.param("filter");
    if (f) state.filters = f.split(",").filter(Boolean);

    var input = KT.qs("[data-menu-search]");
    if (state.q) input.value = state.q;

    var sortSel = KT.qs("[data-menu-sort]");
    sortSel.innerHTML = SORTS.map(function (s) {
      return '<option value="' + s[0] + '">' + s[1] + "</option>";
    }).join("");
    sortSel.value = state.sort;

    jumpList();
    refresh();

    /* Search */
    input.addEventListener(
      "input",
      KT.debounce(function () {
        state.q = input.value.trim();
        KT.qs("[data-menu-clear]").hidden = !state.q;
        results();
        syncUrl();
      }, 200)
    );
    KT.qs("[data-menu-clear]").hidden = !state.q;
    KT.qs("[data-menu-clear]").addEventListener("click", function () {
      input.value = "";
      state.q = "";
      this.hidden = true;
      results();
      syncUrl();
      input.focus();
    });

    /* Categories */
    KT.qs("[data-menu-cats]").addEventListener("click", function (e) {
      var b = e.target.closest("[data-cat]");
      if (!b) return;
      state.category = b.getAttribute("data-cat");
      refresh();
      window.scrollTo({ top: KT.qs(".menu__layout").offsetTop - 180, behavior: "smooth" });
    });

    /* Filters */
    KT.qs("[data-menu-filters]").addEventListener("click", function (e) {
      var b = e.target.closest("[data-filter]");
      if (!b) return;
      var id = b.getAttribute("data-filter");
      var i = state.filters.indexOf(id);
      if (i > -1) state.filters.splice(i, 1);
      else state.filters.push(id);
      refresh();
    });

    /* Sort */
    sortSel.addEventListener("change", function () {
      state.sort = sortSel.value;
      results();
    });

    /* View toggle */
    KT.qsa("[data-view]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.view = b.getAttribute("data-view");
        KT.qsa("[data-view]").forEach(function (x) {
          x.classList.toggle("is-active", x === b);
        });
        results();
      });
    });

    /* Reset from the empty state */
    document.addEventListener("click", function (e) {
      if (!e.target.closest("[data-reset]")) return;
      state.filters = [];
      state.q = "";
      state.category = "all";
      input.value = "";
      refresh();
    });

    /* Deep link from the hero / footer */
    if (location.hash === "#search") input.focus();
  };
})(window.KT || (window.KT = {}));
